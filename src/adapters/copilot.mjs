import { Runtime } from '../runtime.mjs';
import { RuntimeFault, check, id } from '../errors.mjs';
import { SessionRegistry, sessionKey } from '../session-reuse.mjs';
import { extractStructuredOutput } from '../schema.mjs';
import { unsupported } from '../capabilities.mjs';
import { CopilotClient } from '@github/copilot-sdk';
export { defineTool } from '@github/copilot-sdk';

const COMPLETE_FINISH_REASONS = new Set(['stop', 'end_turn', 'completed', 'success']);
const DEFAULT_QUIESCE_TIMEOUT_MS = 10000;

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
    systemMessage,
    tools = [],
    availableTools,
    excludedTools,
    permissionPolicy,
    defaultPermissionDecision = 'reject_once',
    ...legacyOptions
  } = {}) {
    super({ command: 'copilot-sdk', unavailableCode: 'copilot_unavailable', permissionPolicy, defaultPermissionDecision, ...legacyOptions });
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.quiesceTimeoutMs = quiesceTimeoutMs;
    this.client = client;
    this.clientFactory = clientFactory || (options => new CopilotClient(options));
    this.clientOptions = clientOptions;
    this.systemMessage = systemMessage;
    this.tools = tools.map(normalizeTool);
    this.availableTools = availableTools;
    this.excludedTools = excludedTools;
    this.sessions = new SessionRegistry();
    this.sessionObjects = new Map();
    this.turns = new Map();
    this.commands = new Map();
    this.pendingPermissions = new Map();
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

  #permissionResult(decision) {
    if (decision === 'allow_once') return { kind: 'approve-once' };
    if (decision === 'allow_always') return { kind: 'approve-for-session' };
    return { kind: 'reject', feedback: decision === 'cancel' ? 'Floe cancelled this operation.' : 'Floe denied this operation.' };
  }

  #manualPermission(request, normalized) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(normalized.id);
        resolve(this.#permissionResult('reject_once'));
      }, this.unhandledRequestTimeoutMs);
      timer.unref?.();
      this.pendingPermissions.set(normalized.id, { resolve, timer });
      this.emit('request', { id: normalized.id, method: 'permission/request', params: normalized, raw: request });
    });
  }

  #permissionHandler() {
    return async (request, invocation = {}) => {
      const normalized = {
        runtime: 'copilot', sessionId: invocation.sessionId || '', id: request.toolCallId || id('permission'),
        title: request.toolName || request.kind || 'Permission requested',
        kind: request.kind || 'tool', options: [
          { id: 'approve', decision: 'allow_once', label: 'Allow once' },
          { id: 'reject', decision: 'reject_once', label: 'Reject' },
        ], raw: request,
      };
      if (this.listenerCount('request') > 0) return this.#manualPermission(request, normalized);
      let decision = this.defaultPermissionDecision;
      if (this.permissionPolicy) {
        try { decision = await this.permissionPolicy(normalized); }
        catch (error) { this.emit('diagnostic', `permissionPolicy threw; falling back to the default decision: ${error.message}`); }
      }
      return this.#permissionResult(decision);
    };
  }

  #sessionConfig(cwd, model, settings = {}, sessionId) {
    const systemMessage = settings.systemMessage || this.systemMessage;
    const config = {
      ...(sessionId ? { sessionId } : {}),
      model: model || undefined,
      workingDirectory: cwd,
      streaming: true,
      tools: [...this.tools, ...(settings.tools || [])].map(normalizeTool),
      availableTools: settings.availableTools ?? this.availableTools,
      excludedTools: settings.excludedTools ?? this.excludedTools,
      onPermissionRequest: this.#permissionHandler(),
    };
    if (systemMessage) config.systemMessage = typeof systemMessage === 'string'
      ? { mode: 'append', content: systemMessage }
      : systemMessage;
    return config;
  }

  async #getSession(cwd, model, settings, continuation) {
    if (continuation.sessionId && this.sessionObjects.has(continuation.sessionId)) {
      const session = this.sessionObjects.get(continuation.sessionId);
      this.sessions.get(continuation.sessionId).stopped = true;
      return { session, sessionId: continuation.sessionId, reused: true, reason: 'Continuing the same session.' };
    }
    if (continuation.sessionId && continuation.resumable !== false) {
      try {
        const session = await this.client.resumeSession(continuation.sessionId, this.#sessionConfig(cwd, model, settings, continuation.sessionId));
        this.sessionObjects.set(session.sessionId, session);
        this.sessions.set(session.sessionId, { key: null, result: { sessionId: session.sessionId } });
        return { session, sessionId: session.sessionId, reused: true, reason: 'Resumed persisted session.' };
      } catch (error) {
        this.emit('diagnostic', `Could not resume session ${continuation.sessionId}: ${error.message}`);
      }
    }
    const session = await this.client.createSession(this.#sessionConfig(cwd, model, settings));
    this.sessionObjects.set(session.sessionId, session);
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
      task.usage = data;
      this.publish(sessionId, 'usage', { runtime: 'copilot', sessionId, ...data });
    } else if (event.type === 'tool.execution_start') {
      task.items.push(data);
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
    const finish = task.finishReason;
    let error = null;
    if (task.aborted) error = sdkError('interrupted', 'Turn was cancelled.', 409);
    else if (task.sessionError) error = sdkError('session_error', task.sessionError.message || 'Copilot session failed.', 502);
    else if (task.modelCallFailure) error = sdkError('model_call_failure', task.modelCallFailure.message || 'Copilot model call failed.', 502);
    else if (!task.finalMessage) error = sdkError('missing_final_message', 'Copilot reached session.idle without a final assistant message.', 502);
    else if (finish && !COMPLETE_FINISH_REASONS.has(finish)) error = sdkError('report_incomplete', `The Copilot response was not complete (finish reason: ${finish}).`, 502);
    if (error) {
      this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: error.code === 'interrupted' ? 'interrupted' : 'failed', stopReason: finish || error.code });
      task.reject(error);
    } else {
      try {
        const report = task.schema ? extractStructuredOutput(task.finalMessage, task.schema, { role: task.role }) : task.finalMessage;
        const stopReason = finish || 'end_turn';
        this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'completed', stopReason });
        task.resolve({ report, text: task.finalMessage, sessionId, turnId: task.turnId, stopReason, items: task.items, usage: task.usage, elapsedMs: Date.now() - task.started });
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
      finalMessage: null, finishReason: null, usage: null, activities: new Map(), resolve: resolveResult,
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
    await session.setModel(modelId);
    const record = this.sessions.get(sessionId);
    if (record) record.currentModelId = modelId;
  }

  respond(requestId, result) {
    const pending = this.pendingPermissions.get(String(requestId));
    if (!pending) return super.respond(requestId, result);
    this.pendingPermissions.delete(String(requestId));
    clearTimeout(pending.timer);
    const selected = result?.outcome?.optionId || result?.decision || result;
    pending.resolve(this.#permissionResult(selected === 'allow' ? 'allow_once' : selected === 'reject' ? 'reject_once' : selected));
  }

  respondError(requestId, message, code) {
    const pending = this.pendingPermissions.get(String(requestId));
    if (!pending) return super.respondError(requestId, message, code);
    this.pendingPermissions.delete(String(requestId));
    clearTimeout(pending.timer);
    pending.resolve(this.#permissionResult('reject_once'));
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
    this.sessions.delete(sessionId);
    return { status: 'retiredLocally' };
  }

  async resume(sessionId, cwd) {
    await this.start();
    const session = await this.client.resumeSession(sessionId, this.#sessionConfig(cwd, this.model, {}, sessionId));
    this.sessionObjects.set(sessionId, session);
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
    this.sessions.clear();
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer);
      pending.resolve(this.#permissionResult('reject_once'));
    }
    this.pendingPermissions.clear();
    this.ready = false;
    this.client = null;
  }
}
