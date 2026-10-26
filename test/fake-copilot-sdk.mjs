// Mirrors live CLI 1.0.95: GPT models get the codex tool set, others the default set.
const CODEX_ONLY = new Set(['rg', 'apply_patch']);
const DEFAULT_ONLY = new Set(['grep', 'create', 'edit']);
function modelCatalog(model, filters) {
  const absent = /^gpt-/i.test(model || '') ? DEFAULT_ONLY : CODEX_ONLY;
  return filters.filter(filter => !(filter.startsWith('builtin:') && absent.has(filter.slice(8))));
}

// Reasoning-effort levels per model, shaped like live listModels(). fixture-model declares nothing (like `auto`).
const MODEL_EFFORTS = {
  'gpt-5-mini': ['low', 'medium', 'high'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.1-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
  'claude-haiku-4.5': [],
};

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
          tools: (client.catalogOverride || modelCatalog(config.model, config.availableTools)).map(filter => ({
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
      model: {
        getCurrent: async () => ({ modelId: this.config.model || 'gpt-5-mini' }),
      },
      // Mirrors live CLI 1.0.95: events carry the request's trigger, and a failed compaction is
      // reported as a failed compaction_complete event before the call rejects.
      history: {
        compact: async (input = {}) => {
          this.client.compactCalls.push(input);
          const trigger = input.trigger;
          this.emit('session.compaction_start', { trigger, currentTokens: 5000, tokenLimit: 272000 });
          if (this.client.compactFailure) {
            this.emit('session.compaction_complete', { success: false, error: this.client.compactFailure, trigger, customInstructions: input.customInstructions });
            throw new Error(`Request session.history.compact failed with message: ${this.client.compactFailure}`);
          }
          const outcome = { tokensRemoved: 4000, messagesRemoved: 3, summaryContent: '<overview>Kept the decisions.</overview>' };
          this.emit('session.compaction_complete', {
            success: true, trigger, customInstructions: input.customInstructions,
            preCompactionTokens: 5000, postCompactionTokens: 1000, ...outcome,
          });
          return { success: true, ...outcome, contextWindow: { tokenLimit: 272000, currentTokens: 1000, messagesLength: 1 } };
        },
      },
    };
  }

  /** An automatic compaction, as the SDK runs it in the background. */
  backgroundCompaction() {
    this.emit('session.compaction_start', { trigger: 'threshold', currentTokens: 70000, tokenLimit: 272000 });
    this.emit('session.compaction_complete', {
      success: true, trigger: 'threshold', preCompactionTokens: 70000, postCompactionTokens: 12000,
      tokensRemoved: 58000, messagesRemoved: 1, summaryContent: '<overview>Background summary.</overview>',
    });
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
    if (prompt.includes('[silent-before-ack]')) {
      this.client.pending = this;
      return new Promise(() => {});
    }
    if (prompt.includes('[silent-after-ack]')) {
      this.client.pending = this;
      return 'message-1';
    }
    if (prompt.includes('[silent-after-start]')) {
      this.emit('assistant.turn_start', { turnId: 'model-turn-silent' });
      this.client.pending = this;
      return 'message-1';
    }
    if (prompt.includes('[slow-tool]')) {
      this.emit('assistant.turn_start', { turnId: 'model-turn-slow-tool' });
      this.emit('tool.execution_start', {
        toolCallId: 'tool-slow-1',
        toolName: 'request',
        arguments: { question: 'Wait?' },
      });
      setTimeout(() => {
        this.emit('tool.execution_complete', {
          toolCallId: 'tool-slow-1',
          toolName: 'request',
          success: true,
          result: 'done',
        });
        this.emit('assistant.message', {
          messageId: 'message-slow-1',
          content: '{"ok":true,"summary":"done"}',
        });
        this.emit('session.idle', { aborted: false });
      }, 30);
      return 'message-1';
    }
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
      if (prompt.includes('[effort-usage]')) {
        this.emit('assistant.usage', {
          apiCallId: 'call-effort', model: this.config.model, inputTokens: 10, outputTokens: 2,
          reasoningEffort: this.config.reasoningEffort || 'medium',
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

  // Mirrors live Copilot (SDK 1.0.19): an unsupported level is refused and the session is left unchanged;
  // with no effort, the current one carries over only if the new model supports it.
  async setModel(model, options) {
    this.client.setModelCalls.push([model, options]);
    const levels = MODEL_EFFORTS[model] || [];
    const requested = options?.reasoningEffort;
    if (requested && !levels.includes(requested)) {
      throw new Error(`Request session.model.switchTo failed with message: Reasoning effort '${requested}' is not supported for model '${model}'.`);
    }
    const kept = levels.includes(this.config.reasoningEffort) ? this.config.reasoningEffort : undefined;
    this.config.model = model;
    this.config.reasoningEffort = requested || kept;
  }

  registerHooks(hooks) {
    this.config.hooks = hooks;
  }

  async disconnect() {
    this.client.sendOrder.push('disconnect');
    // The real SDK clears every handler on disconnect.
    this.handlers.clear();
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
    this.listModelsCalls = 0;
    this.setModelCalls = [];
    this.compactCalls = [];
    this.compactFailure = null;
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
    this.listModelsCalls += 1;
    const names = {
      'gpt-5-mini': 'GPT-5 mini', 'fixture-model': 'Fixture model', 'claude-sonnet-5': 'Claude Sonnet 5',
      'gpt-5.1-codex': 'GPT-5.1 Codex', 'gpt-5.4': 'GPT-5.4', 'claude-haiku-4.5': 'Claude Haiku 4.5',
    };
    return Object.entries(names).map(([id, name]) => {
      const levels = MODEL_EFFORTS[id];
      if (levels === undefined) return { id, name };
      return {
        id, name,
        capabilities: { supports: { reasoningEffort: levels.length > 0 } },
        ...(levels.length ? { supportedReasoningEfforts: levels } : {}),
      };
    });
  }

  async listSessions() {
    return [...this.sessions.values()].map(session => ({
      sessionId: session.sessionId,
      context: { workingDirectory: session.config.workingDirectory },
    }));
  }
}
