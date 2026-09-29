/**
 * @invariant CopilotRuntime owns the official SDK boundary. Clients use
 * caller-owned storage without ambient configuration, and every session must
 * match the user OAuth account confirmed by readiness before a turn can run.
 */
import { Runtime } from '../runtime.mjs';
import { RuntimeFault, check, id } from '../errors.mjs';
import { SessionRegistry, sessionKey } from '../session-reuse.mjs';
import { extractStructuredOutput } from '../schema.mjs';
import { unsupported } from '../capabilities.mjs';
import { CopilotClient } from '@github/copilot-sdk';
import {
  COPILOT_BUILTIN_TOOL_MANIFEST,
  COPILOT_TOOL_MANIFEST_VERSION,
  createCopilotToolHook,
  prepareCopilotToolSession,
  resolveCopilotToolSelection,
} from './copilot-tools.mjs';
import { copilotChildEnvironment } from './copilot-account.mjs';
export { defineTool } from '@github/copilot-sdk';
export { CopilotEngineAccountAdapter, copilotChildEnvironment } from './copilot-account.mjs';
export {
  COPILOT_BUILTIN_TOOL_MANIFEST,
  COPILOT_TOOL_MANIFEST_VERSION,
  createCopilotToolHook,
  copilotToolCatalogForModel,
  normalizeCopilotToolCall,
  normalizeCopilotPermissionRequest,
  resolveCopilotToolSelection,
} from './copilot-tools.mjs';

const COMPLETE_FINISH_REASONS = new Set(['stop', 'end_turn', 'completed', 'success']);
const DEFAULT_QUIESCE_TIMEOUT_MS = 10000;
const TOKEN_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

function sdkError(code, message, status = 502, cause) {
  const error = new RuntimeFault(code, message, status);
  if (cause) error.cause = cause;
  return error;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || typeof tool.handler !== 'function') {
    throw new TypeError('Copilot host tools require a name and handler.');
  }
  return { ...tool };
}

function normalizeExpectedAccount(account) {
  if (!account || typeof account.label !== 'string' || account.label.trim().length === 0) {
    throw new TypeError('CopilotRuntime requires expectedAccount.label from Copilot readiness.');
  }
  return {
    label: account.label.trim(),
    ...(typeof account.host === 'string' && account.host.trim() ? { host: account.host.trim() } : {}),
  };
}

function normalizedHost(host) {
  return typeof host === 'string' ? host.trim().replace(/\/+$/, '').toLowerCase() : '';
}

function isolatedClientOptions(clientOptions) {
  const { gitHubToken: _ignoredToken, env: optionEnvironment, ...options } = clientOptions;
  return {
    ...options,
    mode: 'copilot-cli',
    useLoggedInUser: true,
    env: copilotChildEnvironment({ ...process.env, ...optionEnvironment }),
  };
}

function isolatedSystemMessage(systemMessage) {
  if (!systemMessage) {
    return { mode: 'customize', sections: { environment_context: { action: 'remove' } } };
  }
  if (typeof systemMessage === 'string') {
    return {
      mode: 'customize',
      content: systemMessage,
      sections: { environment_context: { action: 'remove' } },
    };
  }
  if (systemMessage.mode === 'replace') return systemMessage;
  return {
    ...systemMessage,
    mode: 'customize',
    sections: {
      ...systemMessage.sections,
      environment_context: { action: 'remove' },
    },
  };
}

function aggregateUsage(modelCalls, numToolCalls) {
  if (modelCalls.length === 0) return null;
  const latest = modelCalls.at(-1);
  const usage = {
    ...latest,
    numModelCalls: modelCalls.length,
    numToolCalls,
    modelCalls: modelCalls.map(call => ({ ...call })),
  };
  for (const field of TOKEN_USAGE_FIELDS) {
    usage[field] = modelCalls.reduce((total, call) => total + (Number.isFinite(call[field]) ? call[field] : 0), 0);
  }
  return usage;
}

function promptOptions(input) {
  if (typeof input.prompt === 'string') return { prompt: input.prompt };
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw sdkError('invalid_prompt', 'Copilot requires prompt text or supported prompt blocks.', 400);
  }
  const text = [];
  const attachments = [];
  for (const block of input.blocks) {
    if (!block || typeof block !== 'object') throw sdkError('unsupported_prompt_block', 'Copilot prompt blocks must be objects.', 400);
    if (block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
    } else if ((block.type === 'file' || block.type === 'directory') && typeof block.path === 'string') {
      attachments.push({ type: block.type, path: block.path, ...(block.displayName ? { displayName: block.displayName } : {}) });
    } else if (block.type === 'selection' && typeof block.filePath === 'string' && typeof block.displayName === 'string') {
      attachments.push({ type: 'selection', filePath: block.filePath, displayName: block.displayName, ...(block.selection ? { selection: block.selection } : {}), ...(block.text ? { text: block.text } : {}) });
    } else if ((block.type === 'blob' || block.type === 'image') && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      attachments.push({ type: 'blob', data: block.data, mimeType: block.mimeType, ...(block.displayName ? { displayName: block.displayName } : {}) });
    } else {
      throw sdkError('unsupported_prompt_block', `Copilot SDK cannot represent prompt block type '${block.type || 'unknown'}'.`, 400);
    }
  }
  return { prompt: text.join(''), ...(attachments.length ? { attachments } : {}) };
}

export class CopilotRuntime extends Runtime {
  constructor({
    model,
    timeoutMs = 45 * 60 * 1000,
    quiesceTimeoutMs = DEFAULT_QUIESCE_TIMEOUT_MS,
    client,
    clientFactory,
    clientOptions = {},
    expectedAccount,
    systemMessage,
    tools = [],
    availableTools,
    excludedTools,
    permissionPolicy,
    defaultPermissionDecision = 'allow_once',
    toolPolicyTimeoutMs = timeoutMs,
    ...legacyOptions
  } = {}) {
    super({ command: 'copilot-sdk', unavailableCode: 'copilot_unavailable', permissionPolicy, defaultPermissionDecision, ...legacyOptions });
    const hasBaseDirectory = typeof clientOptions.baseDirectory === 'string' && clientOptions.baseDirectory.trim().length > 0;
    if (!hasBaseDirectory) {
      throw new TypeError('CopilotRuntime requires clientOptions.baseDirectory for Floe-owned Copilot state.');
    }
    this.expectedAccount = normalizeExpectedAccount(expectedAccount);
    if (defaultPermissionDecision !== 'allow_once') {
      throw new TypeError('Copilot allows engine tools unless a configured policy restricts them; defaultPermissionDecision must be allow_once.');
    }
    if (!Number.isFinite(toolPolicyTimeoutMs) || toolPolicyTimeoutMs <= 0) {
      throw new TypeError('Copilot toolPolicyTimeoutMs must be a positive finite number.');
    }
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.quiesceTimeoutMs = quiesceTimeoutMs;
    this.client = client;
    this.clientFactory = clientFactory || (options => new CopilotClient(options));
    this.clientOptions = isolatedClientOptions(clientOptions);
    this.systemMessage = systemMessage;
    this.tools = tools.map(normalizeTool);
    this.availableTools = availableTools;
    this.excludedTools = excludedTools;
    this.toolPolicyTimeoutMs = toolPolicyTimeoutMs;
    this.sessions = new SessionRegistry();
    this.sessionObjects = new Map();
    this.sessionContexts = new Map();
    this.turns = new Map();
    this.commands = new Map();
    this.starting = null;
  }

  capabilities() {
    return {
      setModel: true, releaseSession: true, setMode: false, setPermissions: false, setGoal: false,
      compact: false, usage: false, steer: false, fork: false, listSessions: true, resume: true,
      streaming: true, richPrompt: true, availableCommands: false, fleetMode: false,
      scheduleRecurring: false, scheduleOnce: false, directTools: true, systemMessage: true,
    };
  }

  async start() {
    if (this.ready) return this.info;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        if (!this.client) this.client = await this.clientFactory(this.clientOptions);
        await this.client.start();
        this.ready = true;
        this.info = { backend: 'copilot-sdk', sdkVersion: '1.0.13' };
        this.emit('ready', this.info);
        return this.info;
      } catch (error) {
        throw sdkError('copilot_unavailable', `Copilot SDK could not start: ${error.message}`, 503, error);
      }
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async models() {
    await this.start();
    const models = await this.client.listModels();
    return (models || []).map(model => ({ ...model, modelId: model.modelId || model.id }));
  }

  #toolHook(selection) {
    return createCopilotToolHook({
      selection,
      policy: this.permissionPolicy,
      timeoutMs: this.toolPolicyTimeoutMs,
      toolCallId: () => id('tool-call'),
      onDiagnostic: message => this.emit('diagnostic', message),
    });
  }

  #permissionBackstop(request) {
    return {
      kind: 'reject',
      feedback: JSON.stringify({
        code: 'tool_policy_denied',
        tool_call_id: request?.toolCallId || null,
        operation_id: null,
        rule_id: null,
        reason: "Copilot requested permission outside Floe's pre-tool policy gate.",
      }),
    };
  }

  #sessionConfig(cwd, model, settings = {}, sessionId) {
    const systemMessage = settings.systemMessage || this.systemMessage;
    const tools = [...this.tools, ...(settings.tools || [])].map(normalizeTool);
    const selection = resolveCopilotToolSelection({
      tools,
      availableTools: settings.availableTools ?? this.availableTools,
      excludedTools: settings.excludedTools ?? this.excludedTools,
      model,
    });
    const config = {
      ...(sessionId ? { sessionId } : {}),
      model: model || undefined,
      workingDirectory: cwd,
      streaming: true,
      tools,
      availableTools: selection.filters,
      excludedTools: [],
      hooks: { onPreToolUse: this.#toolHook(selection) },
      onPermissionRequest: request => this.#permissionBackstop(request),
      enableExperimentalMode: false,
      enableSessionTelemetry: false,
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      customAgents: [],
      coauthorEnabled: false,
      manageScheduleEnabled: false,
      mcpOAuthTokenStorage: 'in-memory',
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
      includedBuiltinSkills: [],
      skillDirectories: [],
      instructionDirectories: [],
      pluginDirectories: [],
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: 'in-memory',
      enableOnDemandInstructionDiscovery: false,
      toolSearch: { enabled: false },
      memory: { enabled: false },
      mcpServers: {},
      requestExtensions: false,
      systemMessage: isolatedSystemMessage(systemMessage),
    };
    return { config, selection };
  }

  async #assertSessionAccount(session) {
    let auth;
    try {
      auth = await session.rpc?.gitHubAuth?.getStatus();
    } catch (error) {
      throw sdkError('copilot_auth_unverified', `Copilot could not verify the session account: ${error.message}`, 503, error);
    }
    if (!auth?.isAuthenticated) {
      throw sdkError('copilot_account_mismatch', `Copilot session is not authenticated as the readiness account '${this.expectedAccount.label}'.`, 409);
    }
    if (auth.authType !== 'user') {
      throw sdkError('copilot_account_mismatch', `Copilot session selected '${auth.authType || 'unknown'}' authentication instead of the readiness OAuth account '${this.expectedAccount.label}'.`, 409);
    }
    if (typeof auth.login !== 'string' || auth.login.toLowerCase() !== this.expectedAccount.label.toLowerCase()) {
      throw sdkError('copilot_account_mismatch', `Copilot session authenticated as '${auth.login || 'unknown'}' instead of readiness account '${this.expectedAccount.label}'.`, 409);
    }
    if (this.expectedAccount.host && normalizedHost(auth.host) !== normalizedHost(this.expectedAccount.host)) {
      throw sdkError('copilot_account_mismatch', `Copilot session authenticated against '${auth.host || 'unknown'}' instead of readiness host '${this.expectedAccount.host}'.`, 409);
    }
  }

  async #prepareSession(session, cwd, selection) {
    try {
      await this.#assertSessionAccount(session);
      return await prepareCopilotToolSession(session, selection, cwd);
    } catch (error) {
      try { await session.disconnect(); } catch {}
      this.sessionObjects.delete(session.sessionId);
      this.sessionContexts.delete(session.sessionId);
      this.sessions.delete(session.sessionId);
      if (error instanceof RuntimeFault) throw error;
      throw sdkError(error.code || 'copilot_tool_catalog_unavailable', error.message, 503, error);
    }
  }

  async #getSession(cwd, model, settings, continuation) {
    if (continuation.sessionId && this.sessionObjects.has(continuation.sessionId)) {
      const session = this.sessionObjects.get(continuation.sessionId);
      const { selection } = this.#sessionConfig(cwd, model, settings, continuation.sessionId);
      await this.#prepareSession(session, cwd, selection);
      this.sessionContexts.set(continuation.sessionId, { cwd, settings });
      this.sessions.get(continuation.sessionId).stopped = true;
      return { session, sessionId: continuation.sessionId, reused: true, reason: 'Continuing the same session.' };
    }
    if (continuation.sessionId && continuation.resumable !== false) {
      try {
        const { config, selection } = this.#sessionConfig(cwd, model, settings, continuation.sessionId);
        const session = await this.client.resumeSession(continuation.sessionId, config);
        await this.#prepareSession(session, cwd, selection);
        this.sessionObjects.set(session.sessionId, session);
        this.sessionContexts.set(session.sessionId, { cwd, settings });
        this.sessions.set(session.sessionId, { key: null, result: { sessionId: session.sessionId } });
        return { session, sessionId: session.sessionId, reused: true, reason: 'Resumed persisted session.' };
      } catch (error) {
        if (
          String(error?.code || '').startsWith('copilot_tool_')
          || String(error?.code || '').startsWith('copilot_account_')
          || error?.code === 'copilot_auth_unverified'
          || error?.code === 'copilot_permission_mode_unsafe'
        ) throw error;
        this.emit('diagnostic', `Could not resume session ${continuation.sessionId}: ${error.message}`);
      }
    }
    const { config, selection } = this.#sessionConfig(cwd, model, settings);
    const session = await this.client.createSession(config);
    await this.#prepareSession(session, cwd, selection);
    this.sessionObjects.set(session.sessionId, session);
    this.sessionContexts.set(session.sessionId, { cwd, settings });
    return { session, sessionId: session.sessionId, reused: false, reason: continuation.sessionId ? 'The prior session was unavailable.' : 'A fresh session was requested.' };
  }

  #publishStream(sessionId, task, kind, delta, raw) {
    this.publish(sessionId, 'stream', { runtime: 'copilot', sessionId, turnId: task.turnId, kind, delta, raw });
  }

  #handleEvent(sessionId, task, event) {
    const data = event?.data || {};
    task.lastActivity = Date.now();
    if (event.type === 'assistant.turn_start' && data.turnId) task.turnId = data.turnId;
    if (event.type === 'assistant.message_delta') {
      const delta = data.deltaContent || '';
      task.text += delta;
      this.#publishStream(sessionId, task, 'text', delta, event);
    } else if (event.type === 'assistant.message') {
      task.finalMessage = data.content;
      task.text = data.content || task.text;
      task.messageId = data.messageId || task.messageId;
      task.finishReason = data.finishReason || data.stopReason || task.finishReason;
    } else if (event.type === 'assistant.reasoning_delta') {
      this.#publishStream(sessionId, task, 'reasoning', data.deltaContent || '', event);
    } else if (event.type === 'assistant.usage') {
      task.modelCalls.push({ ...data });
      task.usage = aggregateUsage(task.modelCalls, task.toolCallIds.size);
      this.publish(sessionId, 'usage', { runtime: 'copilot', sessionId, ...task.usage });
    } else if (event.type === 'tool.execution_start') {
      task.items.push(data);
      task.toolCallIds.add(data.toolCallId);
      if (task.usage) task.usage = aggregateUsage(task.modelCalls, task.toolCallIds.size);
      task.activities.set(data.toolCallId, { title: data.toolName || data.toolCallId, startedAt: Date.now(), command: null });
      this.publish(sessionId, 'activity', {
        runtime: 'copilot', sessionId, turnId: task.turnId, id: data.toolCallId, kind: 'tool',
        status: 'started', title: data.toolName || data.toolCallId, command: null,
        startedAt: task.activities.get(data.toolCallId).startedAt, endedAt: null, raw: event,
      });
    } else if (event.type === 'tool.execution_complete') {
      task.items.push(data);
      const activity = task.activities.get(data.toolCallId) || { title: data.toolName || data.toolCallId, startedAt: Date.now(), command: null };
      task.activities.delete(data.toolCallId);
      this.publish(sessionId, 'activity', {
        runtime: 'copilot', sessionId, turnId: task.turnId, id: data.toolCallId, kind: 'tool',
        status: data.success === false ? 'failed' : 'completed', title: activity.title, command: activity.command,
        startedAt: activity.startedAt, endedAt: Date.now(), raw: event,
      });
    } else if (event.type === 'session.error') {
      task.sessionError = data;
    } else if (event.type === 'session.idle') {
      task.idle = true;
      task.aborted = data.aborted === true;
      this.#finishTask(sessionId, task);
    } else if (event.type === 'model.call_failure') {
      task.modelCallFailure = data;
    }
  }

  #attach(sessionId, session, task) {
    return session.on(event => this.#handleEvent(sessionId, task, event));
  }

  #finishTask(sessionId, task) {
    if (task.finished) return;
    task.finished = true;
    clearTimeout(task.timer);
    this.turns.delete(sessionId);
    this.sessions.markStopped(sessionId);
    task.unsubscribe?.();
    if (task.usage) task.usage = aggregateUsage(task.modelCalls, task.toolCallIds.size);
    const finish = task.finishReason;
    let error = null;
    if (task.aborted) error = sdkError('interrupted', 'Turn was cancelled.', 409);
    else if (task.sessionError) error = sdkError('session_error', task.sessionError.message || 'Copilot session failed.', 502);
    else if (task.modelCallFailure) error = sdkError('model_call_failure', task.modelCallFailure.message || 'Copilot model call failed.', 502);
    else if (finish && !COMPLETE_FINISH_REASONS.has(finish)) error = sdkError('report_incomplete', `The Copilot response was not complete (finish reason: ${finish}).`, 502);
    if (error) {
      this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: error.code === 'interrupted' ? 'interrupted' : 'failed', stopReason: finish || error.code });
      task.reject(error);
    } else {
      try {
        // A turn that ends with no error and no final message is a normal success with empty text.
        const text = task.finalMessage ?? '';
        const report = task.schema ? extractStructuredOutput(text, task.schema, { role: task.role }) : text;
        const stopReason = finish || 'end_turn';
        this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'completed', stopReason });
        task.resolve({ report, text, sessionId, turnId: task.turnId, stopReason, items: task.items, usage: task.usage, elapsedMs: Date.now() - task.started });
      } catch (caught) {
        this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'failed', stopReason: finish || 'end_turn' });
        task.reject(caught);
      }
    }
    task.settle();
  }

  async run(role, input, cwd, onStart = () => {}, settings = {}, continuation = {}) {
    await this.start();
    const model = Object.hasOwn(settings, 'model') ? settings.model : this.model;
    const sendOptions = promptOptions(input);
    const key = sessionKey({ role, cwd, model, settings, permissions: null, scope: continuation.scope });
    const destination = await this.#getSession(cwd, model, settings, continuation);
    const { session, sessionId, reused, reason } = destination;
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { key, result: { sessionId }, currentModelId: model || null });
    else this.sessions.get(sessionId).key = key;
    check(!this.turns.has(sessionId), 'turn_busy', 'The session already has an active turn.', 409);
    let resolveResult; let rejectResult; let settle;
    const completion = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const settled = new Promise(resolve => { settle = resolve; });
    const task = {
      role, schema: input.schema, started: Date.now(), turnId: id('turn'), items: [], text: '',
      finalMessage: null, finishReason: null, usage: null, modelCalls: [], toolCallIds: new Set(), activities: new Map(), resolve: resolveResult,
      reject: rejectResult, settle, settled, idle: false, abortRequested: false, finished: false,
      timer: null, lastActivity: Date.now(),
    };
    task.timer = setTimeout(async () => {
      try {
        await this.interrupt(sessionId);
        await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(sdkError('quiescence_unknown', 'Copilot did not confirm quiescence after timeout.', 409)), this.quiesceTimeoutMs))]);
      } catch (error) {
        if (!task.finished) { task.finished = true; this.turns.delete(sessionId); rejectResult(error); settle(); }
      }
    }, settings.timeoutMs || this.timeoutMs);
    task.unsubscribe = this.#attach(sessionId, session, task);
    this.turns.set(sessionId, task);
    this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'started' });
    try {
      await onStart(sessionId, { model: model || null, runtimeInstance: this, session: { action: reused ? 'reused' : 'fresh', reason } });
      await session.send(sendOptions);
    } catch (error) {
      if (!task.finished) {
        task.finished = true;
        clearTimeout(task.timer);
        this.turns.delete(sessionId);
        task.unsubscribe?.();
        const fault = typeof error?.code === 'string'
          ? error
          : sdkError('model_call_failure', `Copilot model call failed: ${error.message}`, 502, error);
        this.publish(sessionId, 'turn', {
          runtime: 'copilot',
          sessionId,
          turnId: task.turnId,
          phase: fault.code === 'interrupted' ? 'interrupted' : 'failed',
          stopReason: fault.code,
        });
        rejectResult(fault);
        settle();
      }
    }
    return completion;
  }

  async setModel(sessionId, modelId) {
    const session = this.sessionObjects.get(sessionId);
    check(session, 'session_unavailable', `Copilot session '${sessionId}' is unavailable.`, 404);
    const context = this.sessionContexts.get(sessionId);
    check(context, 'session_unavailable', `Copilot session '${sessionId}' has no tool-catalog context.`, 404);
    try {
      await session.setModel(modelId);
      const { config, selection } = this.#sessionConfig(context.cwd, modelId, context.settings, sessionId);
      session.registerHooks?.(config.hooks);
      const updated = await session.rpc?.options?.update?.({
        availableTools: selection.filters,
        excludedTools: [],
        toolFilterPrecedence: 'excluded',
      });
      if (!updated || updated.success === false) {
        throw sdkError('copilot_tool_catalog_unavailable', 'Copilot could not update its exact tool allowlist after the model changed.', 503);
      }
      await this.#prepareSession(session, context.cwd, selection);
      const record = this.sessions.get(sessionId);
      if (record) record.currentModelId = modelId;
    } catch (error) {
      try { await session.disconnect(); } catch {}
      this.sessionObjects.delete(sessionId);
      this.sessionContexts.delete(sessionId);
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  async interrupt(sessionId) {
    const task = this.turns.get(sessionId);
    if (!task) return;
    task.abortRequested = true;
    await this.sessionObjects.get(sessionId)?.abort();
  }

  async quiesce(sessionId) {
    const task = this.turns.get(sessionId);
    if (!task) { this.sessions.markStopped(sessionId); return; }
    await this.interrupt(sessionId);
    try {
      await Promise.race([task.settled, new Promise((_, reject) => setTimeout(() => reject(sdkError('quiescence_unknown', 'Copilot did not emit session.idle after abort.', 409)), this.quiesceTimeoutMs))]);
    } finally {
      if (!this.turns.has(sessionId)) this.sessions.markStopped(sessionId);
    }
  }

  async retire(sessionId) {
    const session = this.sessionObjects.get(sessionId);
    if (!session) return { status: 'unavailable' };
    check(!this.turns.has(sessionId), 'quiescence_unknown', 'Confirm the assignment stopped before retiring its session.', 409);
    await session.disconnect();
    this.sessionObjects.delete(sessionId);
    this.sessionContexts.delete(sessionId);
    this.sessions.delete(sessionId);
    return { status: 'retiredLocally' };
  }

  async resume(sessionId, cwd) {
    await this.start();
    const { config, selection } = this.#sessionConfig(cwd, this.model, {}, sessionId);
    const session = await this.client.resumeSession(sessionId, config);
    await this.#prepareSession(session, cwd, selection);
    this.sessionObjects.set(sessionId, session);
    this.sessionContexts.set(sessionId, { cwd, settings: {} });
    this.sessions.set(sessionId, { key: null, result: { sessionId } });
    return sessionId;
  }

  async setMode() { unsupported('copilot', 'setMode'); }
  async setPermissions() { unsupported('copilot', 'setPermissions'); }
  async setGoal() { unsupported('copilot', 'setGoal'); }
  async compact() { unsupported('copilot', 'compact'); }
  async usage() { unsupported('copilot', 'usage'); }
  async steer() { unsupported('copilot', 'steer'); }
  async fork() { unsupported('copilot', 'fork'); }
  async listSessions() { await this.start(); return this.client.listSessions(); }
  availableCommands() { unsupported('copilot', 'availableCommands'); }
  async sweepOrphans() { return { swept: [], checked: 0 }; }

  async onClosing() {
    for (const sessionId of this.turns.keys()) await this.interrupt(sessionId).catch(() => {});
    for (const session of this.sessionObjects.values()) await session.disconnect().catch(() => {});
  }

  async close() {
    await this.onClosing();
    if (this.client) await this.client.stop();
    this.sessionObjects.clear();
    this.sessionContexts.clear();
    this.sessions.clear();
    this.ready = false;
    this.client = null;
  }
}
