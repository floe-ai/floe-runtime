export class FakeCopilotSession {
  constructor(id, config, client) {
    this.sessionId = id;
    this.config = config;
    this.client = client;
    this.handlers = new Set();
    this.aborted = false;
    this.permissionCalls = [];
    this.rpc = {
      permissions: {
        configure: async input => { this.permissionCalls.push(['configure', input]); return { success: true }; },
        setApproveAll: async input => { this.permissionCalls.push(['setApproveAll', input]); return { success: true }; },
        setMode: async input => { this.permissionCalls.push(['setMode', input]); return { success: true, mode: input.mode }; },
        resetSessionApprovals: async input => { this.permissionCalls.push(['resetSessionApprovals', input]); return { success: true }; },
      },
      tools: {
        initializeAndValidate: async () => ({ success: true }),
        getCurrentMetadata: async () => ({
          tools: (client.catalogOverride || config.availableTools).map(filter => ({
            name: filter.includes(':') ? filter.slice(filter.indexOf(':') + 1) : filter,
            description: '',
          })),
        }),
      },
      options: {
        update: async input => {
          this.config.availableTools = input.availableTools;
          this.client.optionsUpdates = [...(this.client.optionsUpdates || []), input];
          return { success: true };
        },
      },
      gitHubAuth: {
        getStatus: async () => ({ ...client.authStatus }),
      },
    };
  }

  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(type, data = {}) {
    const event = { type, data };
    for (const handler of [...this.handlers]) handler(event);
  }

  async send(options) {
    const { prompt } = options;
    this.client.sendOrder.push('send');
    this.client.lastSendOptions = options;
    if (prompt.includes('[send-error]')) throw new Error('model request failed');
    if (prompt.includes('[cancel-tool]')) {
      this.emit('assistant.turn_start', { turnId: 'model-turn-cancelled' });
      this.emit('tool.execution_start', {
        toolCallId: 'tool-cancelled-1',
        toolName: 'powershell',
        arguments: { command: 'Start-Sleep -Seconds 30' },
      });
      this.client.pending = this;
      return 'message-1';
    }
    if (prompt.includes('[cancel]')) {
      this.client.pending = this;
      return 'message-1';
    }
    setTimeout(async () => {
      this.emit('assistant.turn_start', { turnId: 'model-turn-1' });
      if (prompt.includes('[permission]')) {
        this.client.permissionResult = await this.config.hooks.onPreToolUse({
          sessionId: this.sessionId,
          toolName: 'view',
          toolArgs: { path: 'C:\\work\\file.txt' },
          timestamp: new Date(),
          workingDirectory: 'C:\\work',
        }, { sessionId: this.sessionId });
      }
      if (prompt.includes('[stream]')) {
        this.emit('assistant.message_delta', { messageId: 'message-1', deltaContent: '{"ok":' });
        this.emit('assistant.message_delta', { messageId: 'message-1', deltaContent: 'true,"summary":"streamed"}' });
      }
      if (prompt.includes('[multi-usage]')) {
        this.emit('assistant.usage', {
          apiCallId: 'call-1', model: 'fixture-model', inputTokens: 100, outputTokens: 20,
          cacheReadTokens: 40, cacheWriteTokens: 5, numToolCalls: 0,
        });
        this.emit('tool.execution_start', { toolCallId: 'tool-usage-1', toolName: 'request', arguments: { question: 'First?' } });
        this.emit('tool.execution_complete', { toolCallId: 'tool-usage-1', toolName: 'request', success: true, result: 'first' });
        this.emit('assistant.usage', {
          apiCallId: 'call-2', model: 'fixture-model', inputTokens: 150, outputTokens: 30,
          cacheReadTokens: 60, numToolCalls: 0,
        });
        this.emit('tool.execution_start', { toolCallId: 'tool-usage-2', toolName: 'list_pulses', arguments: {} });
        this.emit('tool.execution_complete', { toolCallId: 'tool-usage-2', toolName: 'list_pulses', success: true, result: [] });
        this.emit('assistant.usage', {
          apiCallId: 'call-3', model: 'fixture-model', inputTokens: 200, outputTokens: 50,
          cacheWriteTokens: 7, numToolCalls: 0,
        });
      }
      if (prompt.includes('[tool]')) {
        this.emit('tool.execution_start', { toolCallId: 'tool-1', toolName: 'lookup', arguments: { id: '1' } });
        this.emit('tool.execution_complete', { toolCallId: 'tool-1', toolName: 'lookup', success: true, result: 'found' });
      }
      if (!prompt.includes('[missing]') && !prompt.includes('[error]')) {
        const content = prompt.includes('[incomplete]')
          ? '{"ok":true,"summary":"partial"}'
          : '{"ok":true,"summary":"done"}';
        this.emit('assistant.message', { messageId: 'message-1', content, ...(prompt.includes('[incomplete]') ? { finishReason: 'length' } : {}) });
      }
      if (prompt.includes('[model-call-failure]')) this.emit('model.call_failure', { message: 'provider failed' });
      if (prompt.includes('[multi]')) this.emit('assistant.turn_end', { turnId: 'model-turn-1' });
      if (prompt.includes('[error]')) this.emit('session.error', { errorType: 'model_call', message: 'model failed' });
      this.emit('session.idle', { aborted: false });
    }, 0);
    return 'message-1';
  }

  async abort() {
    this.client.sendOrder.push('abort');
    if (this.client.abortWithoutIdle) return;
    setTimeout(() => {
      this.emit('abort', { reason: 'user_initiated' });
      this.emit('session.idle', { aborted: true });
    }, 0);
  }

  async setModel(model) {
    this.config.model = model;
  }

  registerHooks(hooks) {
    this.config.hooks = hooks;
  }

  async disconnect() {
    this.client.sendOrder.push('disconnect');
  }
}

export class FakeCopilotClient {
  constructor(options = {}) {
    this.options = options;
    this.authStatus = {
      isAuthenticated: true,
      authType: 'user',
      login: 'octocat',
      host: 'https://github.com',
    };
    this.sessions = new Map();
    this.nextId = 1;
    this.sendOrder = [];
    this.abortWithoutIdle = false;
    this.pending = null;
  }

  async start() {}

  async stop() {}

  async createSession(config) {
    const session = new FakeCopilotSession(config.sessionId || `session-${this.nextId++}`, config, this);
    this.sessions.set(session.sessionId, session);
    this.createdConfig = config;
    return session;
  }

  async resumeSession(sessionId, config) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session not found');
    session.config = { ...session.config, ...config };
    return session;
  }

  async listModels() {
    return [{ id: 'gpt-5-mini', name: 'GPT-5 mini' }, { id: 'fixture-model', name: 'Fixture model' }];
  }

  async listSessions() {
    return [...this.sessions.keys()].map(sessionId => ({ sessionId }));
  }
}
