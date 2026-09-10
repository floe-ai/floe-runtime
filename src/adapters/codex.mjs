// Codex adapter: drives `codex app-server` as a subprocess and speaks its
// thread/turn JSON-RPC protocol. Generalized from star-map's src/codex.mjs -
// the thread/turn mechanics, session-reuse mechanics, and quiesce/retire
// mechanics are preserved; app-specific bits (Star Map's role vocabulary,
// its hardcoded prompt templates, its ACCESS_MODES) are removed. Callers
// supply the final prompt text and (optionally) a JSON Schema per call.
import { Runtime } from '../runtime.mjs';
import { RuntimeFault, check, id } from '../errors.mjs';
import { SessionRegistry, sessionKey } from '../session-reuse.mjs';
import { extractStructuredOutput } from '../schema.mjs';
import { codexActivityKind, codexActivityTitle } from '../activity.mjs';
import { unsupported } from '../capabilities.mjs';

// F9: `turn.error.codexErrorInfo` values confirmed (or reasonably expected as siblings) to mean "this
// failed because of a billing/quota wall", not a genuine task failure. Only 'usageLimitExceeded' has
// been observed live so far; the others are plausible sibling codes for the same family and are listed
// here so a newly-observed one only needs a one-line addition, not a new code path, once confirmed.
const USAGE_FAULT_CODES = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'quotaExceeded']);

const DEFAULT_PERMISSIONS = Object.freeze({
  approvalPolicy: 'on-request',
  sandbox: 'read-only',
  sandboxPolicy: { type: 'readOnly' },
});

// P4 setPermissions() neutral-level -> Codex's own approvalPolicy/sandbox vocabulary.
// Codex has no live mid-thread permission RPC, so a level set here is applied
// as an override on this thread's NEXT turn/start call (see run()'s permissions
// resolution), not retroactively to any turn already in flight.
const PERMISSION_LEVELS = Object.freeze({
  'read-only': { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
  prompt: { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  'allow-all': { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
});

// A confirmation-shaped elicitation (empty requestedSchema) asks a plain
// yes/no question and can be answered via the normalized permission policy.
// An elicitation with real requested fields needs actual typed values, which
// no generic policy can fabricate safely - those are left for manual
// handling via the 'request' event only.
function isToolConfirmation(params) {
  const schema = params?.requestedSchema;
  return ['form', 'openai/form'].includes(params?.mode) && schema?.type === 'object'
    && !!schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    && Object.keys(schema.properties).length === 0 && (schema.required || []).length === 0;
}

export class CodexRuntime extends Runtime {
  constructor({ executable = 'codex', args = [], model, timeoutMs = 45 * 60 * 1000, permissionPolicy, defaultPermissionDecision, unhandledRequestTimeoutMs } = {}) {
    const env = { ...process.env, FLOE_RUNTIME_AGENT: '1' };
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
    delete env.CODEX_APP_TOOLS_PIPE_PATH;
    delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    super({ command: executable, args: [...args, 'app-server'], env, unavailableCode: 'codex_unavailable', permissionPolicy, defaultPermissionDecision, unhandledRequestTimeoutMs });
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.turns = new Map();
    this.serverRequests = new Map();
    this.sessions = new SessionRegistry();
    this.instanceId = null;
    // Best-effort per-thread overrides applied on the NEXT turn/start (see
    // setModel()/setPermissions() - Codex has no confirmed live mid-thread RPC
    // for either, so both are modelled as overrides consumed by run()).
    this.modelOverrides = new Map();
    this.permissionOverrides = new Map();
    // F11: last-known objective per threadId, set by setGoal()/cleared alongside it - this runtime
    // instance's own memory of what it last asked for, used to re-apply a goal after resume() silently
    // clears it server-side (see resume() below). This does NOT survive a full process restart on its
    // own; a caller resuming in a FRESH process (or via Fleet's crash recovery, which creates a fresh
    // adapter instance) must pass its own persisted goal explicitly as resume()'s `goal` option.
    this.goals = new Map();
  }

  /** See src/capabilities.mjs; every parity-surface method below is backed by one of these. */
  // eslint-disable-next-line class-methods-use-this
  capabilities() {
    return {
      setModel: true, releaseSession: true, setMode: false, setPermissions: true, setGoal: true, compact: true,
      usage: true, steer: true, fork: true, listSessions: true, resume: true, streaming: true, richPrompt: true,
      availableCommands: false,
      // S5/S6: no equivalent to Copilot's /fleet, /every, /after control commands has been found on Codex.
      fleetMode: false, scheduleRecurring: false, scheduleOnce: false,
    };
  }

  async handshake(peer) {
    this.instanceId = id('runtime');
    this.sessions.clear();
    const info = await peer.request('initialize', {
      clientInfo: { name: 'floe_runtime', title: 'Floe Runtime', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    peer.notify('initialized', {});
    return info;
  }

  onNotification(message) {
    const params = message.params || {};
    const threadId = params.threadId || params.thread?.id;
    const task = threadId && this.turns.get(threadId);
    if (task) {
      task.lastActivity = Date.now();
      if (message.method === 'turn/started' && !task.turnId) task.turnId = params.turn?.id;
      // Old turn events must not finish or contaminate a later assignment.
      const eventTurnId = params.turnId || (['turn/started', 'turn/completed'].includes(message.method) ? params.turn?.id : null);
      if (eventTurnId && task.turnId && eventTurnId !== task.turnId) return;
      if (message.method === 'item/started' && params.item) this.#emitActivity(threadId, task, params.item, 'started');
      if (message.method === 'item/completed' && params.item) {
        task.items.push(params.item);
        if (params.item.type === 'agentMessage') task.finalText = params.item.text || task.finalText;
        this.#emitActivity(threadId, task, params.item, params.item.status === 'failed' || (Number.isInteger(params.item.exitCode) && params.item.exitCode !== 0) ? 'failed' : 'completed');
      }
      if (message.method === 'thread/tokenUsage/updated') {
        task.usage = params.tokenUsage || params.usage || null;
        // S3: published (never polled for) so a Fleet can track aggregate spend live - see
        // src/fleet.mjs. Codex has no monetary cost field here (only token counts) - Codex has no
        // credit cap of any kind, so Fleet-level budget enforcement for Codex agents is
        // measurement-plus-admission-control only, never backend-enforced (see README).
        this.publish(threadId, 'usage', { runtime: 'codex', threadId, ...(task.usage || {}) });
      }
      if (message.method === 'item/agentMessage/delta') this.#emitStream(threadId, task, 'text', params);
      if (message.method === 'item/reasoning/textDelta' || message.method === 'item/reasoning/summaryTextDelta') this.#emitStream(threadId, task, 'reasoning', params);
      if (message.method === 'item/commandExecution/outputDelta') this.#emitStream(threadId, task, 'commandOutput', params);
      if (message.method === 'turn/completed') this.#completeTurn(threadId, task, params.turn);
    }
    if (message.method === 'serverRequest/resolved') this.serverRequests.delete(String(params.requestId));
    if (message.method === 'thread/closed') this.sessions.delete(threadId);

    // F10: notifications observed arriving from the real server that were previously silently dropped.
    // account/rateLimits/updated is the EARLY WARNING before a usage_limit_exceeded wall (F9) - folded
    // into the same 'usage' event type the budget/Fleet surface already watches (see #completeTurn and
    // usage() above), not a new event type, so consumers get one place to watch for spend signals.
    if (message.method === 'account/rateLimits/updated') {
      this.publish(threadId || 'account', 'usage', { runtime: 'codex', threadId: threadId || null, rateLimits: params });
    }
    // A server-level error notification. Never reuse the 'diagnostic' EVENT TYPE in publish() - it would
    // also fire the plain-string this.emit('diagnostic', ...) contract with an object payload, breaking
    // existing string-only diagnostic listeners. Structured version goes out as 'serverError'; a plain
    // string still goes to the diagnostic emitter for stderr-like visibility.
    if (message.method === 'error') {
      this.emit('diagnostic', `Codex server error: ${params.message || JSON.stringify(params)}`);
      this.publish(threadId || 'account', 'serverError', { runtime: 'codex', threadId: threadId || null, ...params });
    }
    // hook/started and hook/completed represent real work when tied to a thread - fold into the same
    // normalized 'activity' stream as tool calls; otherwise there's no turn context to attach to, so
    // fall back to a diagnostic.
    if (message.method === 'hook/started' || message.method === 'hook/completed') {
      if (task) {
        this.publish(threadId, 'activity', {
          runtime: 'codex', sessionId: threadId, turnId: task.turnId || null, id: params.hook?.id || params.id || null,
          kind: 'hook', status: message.method === 'hook/started' ? 'started' : 'completed', title: params.hook?.name || params.name || 'hook',
          command: null, startedAt: Date.now(), endedAt: message.method === 'hook/completed' ? Date.now() : null, raw: params,
        });
      } else {
        this.emit('diagnostic', `Codex ${message.method}: ${JSON.stringify(params)}`);
      }
    }
    // MCP server startup progress - explains stderr lines like an MCP server failing to authenticate.
    // Surfaced as a diagnostic (so it's visible even without a threadId) plus a structured 'notice' when
    // a thread is known.
    if (message.method === 'mcpServer/startupStatus/updated') {
      this.emit('diagnostic', `MCP server startup status: ${JSON.stringify(params)}`);
      if (threadId) this.publish(threadId, 'notice', { runtime: 'codex', threadId, kind: 'mcpServerStartupStatus', ...params });
    }
    // Settings changed server-side for a thread.
    if (message.method === 'thread/settings/updated' && threadId) {
      this.publish(threadId, 'notice', { runtime: 'codex', threadId, kind: 'settingsChanged', settings: params.settings || params });
    }
    // F11: Codex silently clears a thread's goal on resume. If we're mid-resume (this.replaying has the
    // thread), resume() itself is about to re-apply the goal - this is EXPECTED, not a bug, so stay
    // quiet. If it arrives outside a replaying window, an external actor cleared the goal without going
    // through setGoal(null) - forget our own memory of it and warn, since a silently-cleared objective is
    // exactly the correctness bug this closes.
    if (message.method === 'thread/goal/cleared' && threadId) {
      if (!this.replaying.has(threadId)) {
        const hadGoal = this.goals.has(threadId);
        this.goals.delete(threadId);
        if (hadGoal) {
          this.emit('diagnostic', `WARNING: Codex cleared thread ${threadId}'s goal without an explicit setGoal(null) call.`);
          this.publish(threadId, 'goalReapplyFailed', { threadId, reason: 'goal cleared unexpectedly by the server' });
        }
      }
    }
  }


  /** Emits a normalized 'activity' event; agentMessage items are the final report, not tool activity. */
  #emitActivity(threadId, task, item, status) {
    if (item.type === 'agentMessage') return;
    task.activityStarts ??= new Map();
    const now = Date.now();
    if (status === 'started') task.activityStarts.set(item.id, now);
    const startedAt = task.activityStarts.get(item.id) ?? now;
    if (status !== 'started') task.activityStarts.delete(item.id);
    this.publish(threadId, 'activity', {
      runtime: 'codex', sessionId: threadId, turnId: task.turnId || null, id: item.id,
      kind: codexActivityKind(item.type), status, title: codexActivityTitle(item),
      command: typeof item.command === 'string' ? item.command : item.command ? JSON.stringify(item.command) : null,
      startedAt, endedAt: status === 'started' ? null : now, raw: item,
    });
  }

  /** P12: emits a normalized 'stream' event for live text/reasoning/command-output deltas. Field name for the
   * delta text is not uniformly confirmed across these methods, so this defensively checks the common names. */
  #emitStream(threadId, task, kind, params) {
    const delta = params.delta ?? params.text ?? params.chunk ?? '';
    this.publish(threadId, 'stream', { runtime: 'codex', sessionId: threadId, turnId: task.turnId || null, kind, delta, raw: params });
  }

  onRequest(message) {
    this.serverRequests.set(String(message.id), message);
    const waiting = this.turns.get(message.params?.threadId);
    if (waiting && !waiting.waitingHuman) {
      waiting.waitStarted = Date.now();
      clearTimeout(waiting.timer);
      waiting.remainingMs = Math.max(1000, waiting.deadline - Date.now());
      waiting.waitingHuman = true;
    }
  }

  onLost() {
    this.sessions.clear();
    for (const task of this.turns.values()) { clearTimeout(task.timer); task.reject(new RuntimeFault('codex_disconnected', 'Codex App Server disconnected.', 503)); }
    this.turns.clear();
    this.serverRequests.clear();
  }

  /**
   * Recognizes Codex's approval/elicitation request families as backend-neutral
   * permission requests. Returns null for request types with no yes/no shape
   * (e.g. a data-form elicitation, or requestUserInput) - those remain
   * available only via the 'request' event for manual handling.
   */
  normalizePermissionRequest(message) {
    const method = message.method;
    const p = message.params || {};
    if (method.includes('commandExecution') || method.includes('fileChange')) {
      const allowed = new Set(p.availableDecisions || ['accept', 'decline']);
      const options = [];
      if (allowed.has('accept')) options.push({ id: 'accept', decision: 'allow_once', label: 'Allow once' });
      if (allowed.has('decline')) options.push({ id: 'decline', decision: 'reject_once', label: 'Decline' });
      return {
        runtime: 'codex', sessionId: p.threadId, id: p.itemId || String(message.id),
        title: p.command ? (typeof p.command === 'string' ? p.command : JSON.stringify(p.command)) : (p.reason || method),
        kind: method.includes('fileChange') ? 'file' : 'command', options, raw: message,
      };
    }
    if (method === 'item/permissions/requestApproval') {
      return {
        runtime: 'codex', sessionId: p.threadId, id: String(message.id), title: p.reason || 'Additional permissions requested', kind: 'permissions',
        options: [{ id: 'grant', decision: 'allow_once', label: 'Grant for this turn' }, { id: 'decline', decision: 'reject_once', label: 'Decline' }], raw: message,
      };
    }
    if (method === 'mcpServer/elicitation/request') {
      if (isToolConfirmation(p)) {
        return {
          runtime: 'codex', sessionId: p.threadId, id: String(message.id), title: p.message || 'Tool confirmation requested', kind: 'tool',
          options: [{ id: 'accept', decision: 'allow_once', label: 'Allow once' }, { id: 'decline', decision: 'reject_once', label: 'Decline' }, { id: 'cancel', decision: 'cancel', label: 'Cancel' }], raw: message,
        };
      }
      if (p.mode === 'url') {
        return {
          runtime: 'codex', sessionId: p.threadId, id: String(message.id), title: p.message || 'Complete the requested URL flow', kind: 'tool',
          options: [{ id: 'accept', decision: 'allow_once', label: 'Completed URL flow' }, { id: 'decline', decision: 'reject_once', label: 'Decline' }, { id: 'cancel', decision: 'cancel', label: 'Cancel' }], raw: message,
        };
      }
      return null; // real form data needs actual values, not a yes/no decision
    }
    return null;
  }

  /** Translates a resolved decision back into Codex's per-method response shape. */
  resolvePermissionRequest(message, decision) {
    const method = message.method;
    const p = message.params || {};
    const allow = decision === 'allow_once' || decision === 'allow_always';
    if (method.includes('commandExecution') || method.includes('fileChange')) { this.respond(message.id, { decision: allow ? 'accept' : 'decline' }); return; }
    if (method === 'item/permissions/requestApproval') { this.respond(message.id, { permissions: allow ? (p.permissions || {}) : {}, scope: 'turn' }); return; }
    if (method === 'mcpServer/elicitation/request') {
      if (decision === 'cancel') { this.respond(message.id, { action: 'cancel', content: null }); return; }
      this.respond(message.id, { action: allow ? 'accept' : 'decline', content: allow ? {} : null });
    }
  }

  #completeTurn(threadId, task, turn) {
    this.turns.delete(threadId);
    clearTimeout(task.timer);
    if (turn?.status !== 'completed') {
      const phase = turn?.status === 'interrupted' ? 'interrupted' : 'failed';
      this.publish(threadId, 'turn', { runtime: 'codex', sessionId: threadId, turnId: task.turnId, phase });
      // F9: a spend-cap/quota wall arrives shaped exactly like any other failed turn (turn.status ===
      // 'failed') unless we look inside turn.error.codexErrorInfo - collapsing it into a generic
      // turn_failed makes "the work failed" indistinguishable from "you are out of credit", which is
      // exactly the phantom-failure debugging trap this fixes.
      if (turn?.error && USAGE_FAULT_CODES.has(turn.error.codexErrorInfo)) {
        const reason = turn.error.message || 'The Codex workspace has hit its spend cap.';
        // Surfaced under the SAME event type Fleet's own budget ceiling uses (see src/fleet.mjs), so an
        // app has exactly one signal to learn "stopped for money reasons" regardless of whether our own
        // configured ceiling or the backend's own billing limit tripped first.
        this.publish(threadId, 'budgetCeilingReached', { runtime: 'codex', sessionId: threadId, source: 'backend', codexErrorInfo: turn.error.codexErrorInfo, reason });
        task.reject(new RuntimeFault('usage_limit_exceeded', reason, 402));
        return;
      }
      task.reject(new RuntimeFault(turn?.status === 'interrupted' ? 'interrupted' : 'turn_failed', turn?.error?.message || `Turn ended with ${turn?.status}.`, 409));
      return;
    }
    for (const item of turn.items || []) if (!task.items.some(i => i.id === item.id)) task.items.push(item);
    const text = [...task.items].reverse().find(i => i.type === 'agentMessage' && i.text)?.text || task.finalText;
    try {
      const report = task.schema ? extractStructuredOutput(text, task.schema, { role: task.role }) : text;
      this.publish(threadId, 'turn', { runtime: 'codex', sessionId: threadId, turnId: task.turnId, phase: 'completed' });
      task.resolve({ report, text, threadId, turnId: task.turnId, items: task.items, usage: task.usage, elapsedMs: Date.now() - task.started - task.waitMs });
    } catch (error) {
      this.publish(threadId, 'turn', { runtime: 'codex', sessionId: threadId, turnId: task.turnId, phase: 'failed' });
      task.reject(error);
    }
  }

  /** Responds to a pending Codex server request (approval/elicitation), resuming its turn's timeout clock. */
  respond(requestId, result) {
    check(this.serverRequests.has(String(requestId)), 'request_expired', 'The runtime prompt has expired; it cannot be answered.', 409);
    const request = this.serverRequests.get(String(requestId));
    const task = this.turns.get(request.params?.threadId);
    const otherPending = [...this.serverRequests.entries()].some(([key, value]) => key !== String(requestId) && value.params?.threadId === request.params?.threadId);
    if (task?.waitingHuman && !otherPending) {
      task.waitMs += Date.now() - task.waitStarted;
      task.waitingHuman = false;
      task.deadline = Date.now() + task.remainingMs;
      task.timer = setTimeout(task.expire, task.remainingMs);
    }
    super.respond(requestId, result);
    this.serverRequests.delete(String(requestId));
  }

  /** Lists the models Codex currently exposes, paging through model/list. */
  async models() {
    await this.start();
    const data = [];
    const seen = new Set();
    let cursor;
    do {
      const page = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      check(Array.isArray(page.data), 'models_unavailable', 'Codex did not return its available models.', 502);
      data.push(...page.data);
      cursor = page.nextCursor;
      check(!cursor || !seen.has(cursor), 'models_unavailable', 'Codex repeated a model page.', 502);
      seen.add(cursor);
    } while (cursor);
    return data;
  }

  /** P1: applies a model override for this thread's NEXT turn/start call (Codex has no live mid-thread model RPC). */
  setModel(threadId, modelId) {
    this.modelOverrides.set(threadId, modelId);
  }

  /** P3: Codex has no session-mode concept (interactive/plan/autopilot) - declare unsupported rather than faking it. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async setMode(threadId, mode) { unsupported('codex', 'setMode'); }

  /** P4: sets a permission-level override for this thread's NEXT turn/start call (see PERMISSION_LEVELS above). */
  setPermissions(threadId, level) {
    const permissions = PERMISSION_LEVELS[level];
    check(permissions, 'invalid_permission_level', `Unknown permission level '${level}'.`, 400);
    this.permissionOverrides.set(threadId, permissions);
  }

  /** P5: sets or clears the thread's goal. opts.maxCredits is Copilot-only (there is no Codex AI-credit cap). */
  async setGoal(threadId, objective, opts = {}) {
    await this.start();
    check(opts.maxCredits == null, 'capability_unsupported', 'setGoal opts.maxCredits is not supported by the codex backend.', 501);
    if (objective == null) {
      this.goals.delete(threadId); // F11: tracked so resume() can tell there is nothing to re-apply
      return this.request('thread/goal/clear', { threadId });
    }
    const result = await this.request('thread/goal/set', { threadId, objective });
    this.goals.set(threadId, objective);
    return result;
  }

  /** P6: summarizes/compacts the thread's conversation history. */
  async compact(threadId, focus) {
    await this.start();
    return this.request('thread/compact/start', { threadId, ...(focus ? { focus } : {}) });
  }

  /** P7: reports account-level usage/rate-limit info. Codex has no per-thread usage read; sessionId is accepted for interface parity but ignored. */
  async usage() {
    await this.start();
    const [usageResult, rateLimits] = await Promise.all([
      this.request('account/usage/read', {}), this.request('account/rateLimits/read', {}),
    ]);
    return { backend: 'codex', raw: { usage: usageResult, rateLimits } };
  }

  /** P8: injects steering guidance into a RUNNING turn via turn/steer. */
  async steer(threadId, text) {
    const task = this.turns.get(threadId);
    check(task?.turnId, 'no_active_turn', 'There is no running turn on this thread to steer.', 409);
    return this.request('turn/steer', { threadId, turnId: task.turnId, text });
  }

  /** P9: forks the thread via thread/fork. */
  async fork(threadId) {
    await this.start();
    return this.request('thread/fork', { threadId });
  }

  /** P10: lists known threads via thread/list. */
  async listSessions() {
    await this.start();
    const result = await this.request('thread/list', {});
    return result.data || result.threads || [];
  }

  /** P11: resumes a previously known (non-ephemeral) thread via thread/resume, registering it for reuse/quiesce/retire.
   * This is also the app-restart recovery path (see PART 2): call listSessions() to discover a threadId
   * from a previous process, then resume(threadId) to reconstruct local tracking before passing it back
   * into run() as a continuation. Codex's history arrives as the thread/resume RESULT itself (a single
   * snapshot), not as a stream of notifications - unlike Copilot's session/load, there is nothing
   * incremental to mark replay on, so this publishes one synthetic 'replay' snapshot event followed
   * immediately by 'replayComplete', for symmetry with the Copilot adapter's live-replay signalling.
   *
   * F11: confirmed live - Codex silently clears a thread's goal on resume (a `thread/goal/cleared`
   * notification arrives right after thread/resume). Left unhandled, a resumed conversation would
   * continue with no objective and no warning. `opts.goal` lets the caller supply the last known
   * objective explicitly (the reliable path across a full process restart, since this instance's own
   * `this.goals` memory does not survive one); if omitted, this instance's own same-process memory of
   * the last setGoal() call for this thread is used as a fallback. If re-applying fails, this does NOT
   * fail resume() itself (the conversation is still usable) but publishes an unmistakable
   * 'goalReapplyFailed' event plus a diagnostic - silently continuing with a cleared objective is exactly
   * the bug this closes, so it must never happen quietly. */
  async resume(threadId, opts = {}) {
    await this.start();
    const goal = opts.goal !== undefined ? opts.goal : this.goals.get(threadId);
    this.replaying.add(threadId);
    try {
      const result = await this.request('thread/resume', { threadId });
      const resumedId = result.thread?.id || threadId;
      this.sessions.set(resumedId, { key: null, result, instanceId: this.instanceId });
      this.sessions.markStopped(resumedId);
      this.publish(resumedId, 'replay', { thread: result.thread }, { replay: true });
      if (goal != null) {
        try {
          await this.request('thread/goal/set', { threadId: resumedId, objective: goal });
          this.goals.set(resumedId, goal);
          this.publish(resumedId, 'goalReapplied', { threadId: resumedId, objective: goal });
        } catch (error) {
          this.emit('diagnostic', `CRITICAL: resume() could not re-apply the objective Codex silently cleared: ${error.message}`);
          this.publish(resumedId, 'goalReapplyFailed', { threadId: resumedId, objective: goal, reason: error.message });
        }
      }
      return resumedId;
    } finally {
      this.replaying.delete(threadId);
      this.publish(threadId, 'replayComplete', { threadId });
    }
  }

  /** P14: Codex has no advertised-command surface like Copilot's slash commands - declare unsupported. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  availableCommands(threadId) { unsupported('codex', 'availableCommands'); }

  /** S5: Codex has no single-session parallel-subagent fan-out equivalent to Copilot's /fleet - declare unsupported. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async fleetMode(threadId, prompt) { unsupported('codex', 'fleetMode'); }

  /** S6: Codex has no backend-side recurring-schedule equivalent to Copilot's /every - declare unsupported. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async scheduleRecurring(threadId, interval, prompt) { unsupported('codex', 'scheduleRecurring'); }

  /** S6: Codex has no backend-side one-shot-schedule equivalent to Copilot's /after - declare unsupported. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async scheduleOnce(threadId, delay, prompt) { unsupported('codex', 'scheduleOnce'); }

  /**
   * Orphan sweep (see PART 2 in the README): releases threads this runtime instance is not tracking
   * (`this.sessions`) that thread/list reports as idle for longer than `maxAgeMs` (default 21 days - a
   * generous window, since the whole point of persistent threads is surviving app restarts for a long
   * time). Never sweeps a thread this instance still owns, and never sweeps one whose last-activity
   * timestamp is unknown (safer to leave an unaged thread alone than wrongly release it).
   */
  async sweepOrphans({ maxAgeMs = 21 * 24 * 60 * 60 * 1000 } = {}) {
    await this.start();
    const cutoff = Date.now() - maxAgeMs;
    const threads = await this.listSessions();
    const swept = [];
    for (const thread of threads) {
      if (this.sessions.has(thread.id)) continue;
      const lastActivity = Date.parse(thread.updatedAt || thread.lastActivityAt || thread.status?.updatedAt || '');
      if (Number.isNaN(lastActivity)) { this.emit('diagnostic', `sweepOrphans: thread ${thread.id} has no known last-activity timestamp; leaving it alone.`); continue; }
      if (lastActivity > cutoff) continue;
      try { await this.request('thread/unsubscribe', { threadId: thread.id }); swept.push(thread.id); }
      catch (error) { this.emit('diagnostic', `sweepOrphans: could not release thread ${thread.id}: ${error.message}`); }
    }
    return { swept, checked: threads.length };
  }

  /**
   * Runs one turn.
   * @param {string} role - caller-defined role label, used only for error messages/report validation.
   * @param {{prompt: string, schema?: object, blocks?: object[]}} input - the fully-built prompt text (or, for P13
   *   rich prompt input, a pre-built content-block array which is passed straight through) and optional output JSON Schema.
   *   F8: prompt text is sent to Codex VERBATIM, exactly as if a human had typed it - floe-runtime never
   *   sanitizes, escapes, or intercepts leading slash commands. Callers composing prompts programmatically
   *   must account for this themselves.
   * @param {string} cwd
   * @param {(threadId: string, meta: object) => Promise<void>|void} onStart - called once the thread/turn is about to start.
   * @param {{model?, timeoutMs?, effort?, permissions?, ephemeral?}} settings - `ephemeral` (default false) opts a
   *   single conversation OUT of the default persistent/resumable behaviour (see PART 2 of the README) for
   *   sensitive one-shot work; a persistent thread is the default so conversations survive by default.
   * @param {{threadId?, scope?, reason?}} continuation - reuse hint from a previous run(). Pass a threadId
   *   recovered via listSessions()+resume() to continue a conversation from a previous process.
   */
  async run(role, input, cwd, onStart = () => {}, settings = {}, continuation = {}) {
    await this.start();
    // P1/P4: a setModel()/setPermissions() override for this thread (if any) wins over
    // per-call settings for the NEXT turn/start - see setModel()/setPermissions() above.
    const modelOverride = continuation.threadId && this.modelOverrides.get(continuation.threadId);
    const model = modelOverride || (Object.hasOwn(settings, 'model') ? settings.model : this.model);
    const permissionOverride = continuation.threadId && this.permissionOverrides.get(continuation.threadId);
    const permissions = permissionOverride || settings.permissions || DEFAULT_PERMISSIONS;
    const timeoutMs = settings.timeoutMs || this.timeoutMs;
    // PART 2: persistence is a per-call CHOICE, not a hardcoded constant, and defaults to persistent
    // (ephemeral: false) so a conversation stays alive - and resumable after the app closes and reopens -
    // until the caller explicitly retire()s it. Pass settings.ephemeral: true to opt a single sensitive
    // one-shot task OUT of persistence; that thread can never be resume()d afterwards.
    const ephemeral = settings.ephemeral ?? false;
    const key = sessionKey({ role, cwd, model, settings, permissions, scope: continuation.scope });
    let result;
    let reused = false;
    let reason = continuation.reason || 'A fresh session was requested.';
    const previous = continuation.threadId && this.sessions.get(continuation.threadId);
    // An entry with `key === null` was just resume()d directly by the caller (not auto-resumed by this
    // run() call) and has never yet been claimed by a run() key - treat it as reusable by ANY key and
    // adopt this one, exactly like Copilot's SessionRegistry.isReusable(). Without this, calling
    // resume(threadId) yourself and then run({ continuation: { threadId } }) would never actually reuse
    // the restored thread - every following turn would silently start a brand-new one instead.
    if (previous && previous.key === null) previous.key = key;
    if (previous?.key === key && previous.stopped && continuation.scope) {
      try {
        const state = await this.request('thread/read', { threadId: continuation.threadId, includeTurns: false });
        if (['active', 'systemError'].includes(state.thread?.status?.type)) {
          previous.stopped = false;
          throw new RuntimeFault('quiescence_unknown', 'The previous session unexpectedly became active. A fresh assignment is blocked until its stop is confirmed.', 409);
        }
        if (state.thread?.id === continuation.threadId && state.thread.ephemeral === ephemeral && state.thread.status?.type === 'idle') {
          result = { ...previous.result, thread: state.thread };
          reused = true;
        } else reason = 'The previous session is no longer idle and available.';
      } catch (error) {
        if (error.code !== 'rpc_error') throw error;
        reason = 'The previous session is unavailable.';
      }
    } else if (continuation.threadId) reason = 'The runtime restarted or the session settings changed.';
    if (!reused) {
      if (continuation.threadId) await this.retire(continuation.threadId);
      result = await this.request('thread/start', {
        cwd, ephemeral, ...(model ? { model } : {}),
        approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user', sandbox: permissions.sandbox,
        serviceName: 'floe_runtime',
      });
      // A completed request must match what the caller actually asked for - never silently accept the
      // opposite persistence mode (e.g. a caller requesting a persistent thread must never be handed an
      // ephemeral one it can never resume() later).
      check(result.thread.ephemeral === ephemeral, 'session_mismatch', `Codex created a thread with unexpected persistence (requested ${ephemeral ? 'ephemeral' : 'persistent'}).`, 409);
    }
    const threadId = result.thread.id;
    check(!this.turns.has(threadId), 'turn_busy', 'The thread already has a turn.', 409);
    this.sessions.set(threadId, { key, result, instanceId: this.instanceId });
    let settleResolve;
    let settleReject;
    const completion = new Promise((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
    const expire = () => { this.interrupt(threadId).catch(() => {}); settleReject(new RuntimeFault('turn_timeout', `${role} reached its ${Math.round(timeoutMs / 60000)} minute task limit. Review its activity before resuming.`, 408)); };
    const timer = setTimeout(expire, timeoutMs);
    this.turns.set(threadId, {
      role, schema: input.schema, started: Date.now(), waitMs: 0, items: [], finalText: '', turnId: null,
      timer, expire, deadline: Date.now() + timeoutMs, resolve: settleResolve, reject: settleReject, lastActivity: Date.now(),
      // The settlement promise IS `completion` - quiesce() awaits this directly instead of polling
      // `this.turns.has(threadId)` on a timer (PART 1: no polling anywhere).
      settlement: completion,
    });
    // Observe a rejection immediately even if starting the turn fails first.
    completion.catch(() => {});
    try {
      await onStart(threadId, {
        model: result.model || model || null, effort: settings.effort || result.reasoningEffort || null, ephemeral,
        runtimeInstance: this.instanceId,
        session: { action: reused ? 'reused' : continuation.threadId || continuation.refreshed ? 'refreshed' : 'fresh', reason: reused ? 'Continuing the same session.' : reason },
        ...permissions,
      });
      const started = await this.request('turn/start', {
        threadId, cwd, input: input.blocks || [{ type: 'text', text: input.prompt }], approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user',
        sandboxPolicy: permissions.sandboxPolicy,
        ...(input.schema ? { outputSchema: input.schema } : {}), ...(model ? { model } : {}), ...(settings.effort ? { effort: settings.effort } : {}),
      });
      const task = this.turns.get(threadId);
      if (task) {
        task.turnId = started.turn.id;
        this.publish(threadId, 'turn', { runtime: 'codex', sessionId: threadId, turnId: task.turnId, phase: 'started' });
        if (task.interruptRequested) await this.interrupt(threadId);
      }
    } catch (error) {
      const task = this.turns.get(threadId);
      const unavailable = reused && !task?.turnId && error.code === 'rpc_error' && /(?:thread.*(?:not found|not loaded)|no rollout found)/i.test(error.message);
      if (task) { clearTimeout(task.timer); this.turns.delete(threadId); task.reject(error); }
      if (unavailable) {
        // An explicit missing-thread response means no turn was accepted. Timeouts,
        // disconnects and other ambiguous failures must never replay an assignment.
        this.sessions.markStopped(threadId);
        await this.retire(threadId);
        return this.run(role, input, cwd, onStart, settings, { scope: continuation.scope, refreshed: true, reason: 'The session became unavailable before continuation started.' });
      }
      throw error;
    }
    return completion;
  }

  async interrupt(threadId) {
    const active = this.turns.get(threadId);
    if (!active) return;
    active.interruptRequested = true;
    if (active.turnId) await this.request('turn/interrupt', { threadId, turnId: active.turnId });
  }

  /**
   * Waits (via a single push-event listener, never a timer poll) for `thread/status/changed` to report
   * non-active or a `turn/completed` notification for `threadId` - the signal that it is safe to take one
   * confirmatory thread/read. Bounded by `timeoutMs` (a single timeout, not a retry interval).
   */
  #awaitThreadIdleSignal(threadId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); this.off('notification', handler); };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        reject(new RuntimeFault('quiescence_unknown', 'Timed out waiting for the thread to report idle.', 409));
      }, timeoutMs);
      const handler = message => {
        if (settled) return;
        const params = message.params || {};
        if (params.threadId !== threadId) return;
        if (message.method === 'thread/status/changed' || message.method === 'turn/completed') {
          settled = true; cleanup(); resolve();
        }
      };
      this.on('notification', handler);
    });
  }

  /** Interrupts any active turn, then confirms no in-progress turns or background terminals remain.
   * PART 1 (no polling anywhere): every wait below settles from a pushed notification or a settlement
   * promise, never from re-reading state on a fixed interval; the pagination `do...while` loops over
   * thread/backgroundTerminals/list are enumerating pages, not retrying the same page. */
  async quiesce(threadId) {
    const task = this.turns.get(threadId);
    if (task) {
      await this.interrupt(threadId);
      await Promise.race([
        task.settlement.catch(() => {}),
        new Promise((resolve, reject) => setTimeout(() => reject(new RuntimeFault('quiescence_unknown', 'The active turn has not confirmed interruption.', 409)), 10000)),
      ]);
    }
    const read = () => this.request('thread/read', { threadId, includeTurns: true });
    let state = await read();
    let inProgress = (state.thread?.turns || []).filter(t => t.status === 'inProgress');
    for (const turn of inProgress) await this.request('turn/interrupt', { threadId, turnId: turn.id });
    if (inProgress.length > 0 || state.thread?.status?.type === 'active') {
      await this.#awaitThreadIdleSignal(threadId, 10000);
      state = await read(); // a single confirmatory read triggered by the push notification, not a retry loop
      inProgress = (state.thread?.turns || []).filter(t => t.status === 'inProgress');
    }
    check(state.thread?.status?.type !== 'active' && inProgress.length === 0, 'quiescence_unknown', 'The runtime still has an active turn. Restoring or accepting a workspace is blocked.', 409);
    // A clean turn end alone does not prove every background terminal stopped. This do...while is
    // pagination over thread/backgroundTerminals/list's cursor, not a retry loop.
    let cursor = null;
    do {
      const list = await this.request('thread/backgroundTerminals/list', { threadId, ...(cursor ? { cursor } : {}) });
      const sessions = list.data;
      check(Array.isArray(sessions), 'quiescence_unknown', 'Runtime could not enumerate background terminals. Workspace changes remain blocked.', 409);
      for (const session of sessions) await this.request('thread/backgroundTerminals/terminate', { threadId, processId: session.processId });
      cursor = list.nextCursor;
    } while (cursor);
    // Single read-after-write confirmation, never a retry loop.
    const after = await this.request('thread/backgroundTerminals/list', { threadId });
    check(Array.isArray(after.data) && after.data.length === 0 && !after.nextCursor, 'quiescence_unknown', 'Runtime still reports background work.', 409);
    this.sessions.markStopped(threadId);
  }

  /** Unsubscribes the thread, falling back to local-only retirement if the API is unavailable. */
  async retire(threadId) {
    const session = this.sessions.get(threadId);
    if (!session) return { status: 'unavailable' };
    check(session.stopped && !this.turns.has(threadId), 'quiescence_unknown', 'Confirm the assignment stopped before retiring its session.', 409);
    this.sessions.delete(threadId);
    // Unsubscribe retires an in-memory session without creating stored history.
    // Codex may keep it idle during its documented unload grace period.
    try {
      const result = await this.request('thread/unsubscribe', { threadId });
      check(['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result.status), 'retirement_unknown', 'Codex did not acknowledge session retirement.');
      return result;
    } catch (error) {
      // A stopped session is never eligible again, even if this optional API is unavailable.
      this.emit('diagnostic', 'The stopped session was retired locally; runtime release was unavailable: ' + error.message);
      return { status: 'retiredLocally', reason: error.message };
    }
  }

  async onClosing() {
    for (const threadId of this.turns.keys()) await this.interrupt(threadId).catch(() => {});
  }

  async close() {
    await super.close();
    this.sessions.clear();
  }
}
