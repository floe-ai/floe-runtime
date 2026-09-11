// Copilot adapter: drives `copilot --acp` as a subprocess and speaks the
// Agent Client Protocol (https://agentclientprotocol.com). New backend, no
// prior app implementation to port - built directly against the ACP v1
// spec's session/new + session/prompt + session/update flow.
//
// Key differences from the Codex adapter, all confirmed against the ACP docs
// during design (see floe-runtime design notes):
//  - No server-enforced structured output. The prompt text must ask for JSON
//    (see schema.mjs#promptInstructionFor) and the response is parsed/
//    validated client-side, same mechanism as Codex uses for validation but
//    without a native outputSchema request field.
//  - session/load replays the ENTIRE conversation history back to the client
//    as session/update notifications - it is not a cheap resume. This
//    adapter's default reuse policy therefore keeps sessions alive only in
//    memory for the life of the subprocess (see session-reuse.mjs) and
//    exposes session/load only via the explicit resume() method for
//    optional cold-start recovery, never automatically inside run().
//  - Permission requests (session/request_permission) are normalized into
//    the same backend-neutral shape Codex's approval requests use (see
//    normalizePermissionRequest()/resolvePermissionRequest() below and
//    permissions.mjs) so a caller can write one permissionPolicy for both
//    backends. An explicit 'request' event listener still gets full manual
//    control; see runtime.mjs for the precedence rules.
import { Runtime } from '../runtime.mjs';
import { RuntimeFault, check, id } from '../errors.mjs';
import { SessionRegistry, sessionKey } from '../session-reuse.mjs';
import { extractStructuredOutput } from '../schema.mjs';
import { acpActivityKind } from '../activity.mjs';
import { pickOption } from '../permissions.mjs';
import { unsupported } from '../capabilities.mjs';

// ACP's session/set_mode takes the mode's full URI, not a bare id.
const MODE_URIS = Object.freeze({
  interactive: 'https://agentclientprotocol.com/protocol/session-modes#agent',
  plan: 'https://agentclientprotocol.com/protocol/session-modes#plan',
  autopilot: 'https://agentclientprotocol.com/protocol/session-modes#autopilot',
});

/** Best-effort extraction of a leading integer from control-command reply text, e.g. "Requests: 12". */
function extractCount(text, label) {
  const match = new RegExp(label + ':?\\s*([0-9][0-9,.]*)', 'i').exec(text || '');
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

// F9 (UNCONFIRMED heuristic): keyword scan of a refused turn's accumulated text, used ONLY because the
// user could not verify ACP's real quota/limit refusal shape live. See the call site in #finishTurn for
// the full caveat - replace this with a real structured check the moment the actual shape is observed.
const USAGE_LIMIT_PHRASES = /\b(spend cap|usage limit|quota exceeded|out of credits?|credit limit|rate limit exceeded|insufficient (?:credits?|quota))\b/i;
function looksLikeUsageLimit(text) {
  return typeof text === 'string' && USAGE_LIMIT_PHRASES.test(text);
}

// ACP's StopReason (https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons; exact enum +
// descriptions confirmed in the released schema.json's "StopReason" $def) defines EXACTLY 5 values:
//   end_turn          - "The turn ended successfully."
//   max_tokens        - "The turn ended because the agent reached the maximum number of tokens."
//   max_turn_requests - "...reached the maximum number of allowed agent requests between user turns."
//   refusal           - "...the agent refused to continue. The user prompt and everything that comes
//                        after it won't be included in the next prompt..."
//   cancelled         - "...cancelled by the client via `session/cancel`."
// `end_turn` is the ONLY one that means the model actually finished producing its message - `max_tokens`
// and `max_turn_requests` mean the agent's own final message was cut off mid-stream (possibly mid-JSON).
// Also confirmed in schema.json: PromptResponse (the session/prompt result) carries ONLY `stopReason` (+
// `_meta`) - there is no separate "was this message complete" flag and no structured-result channel at
// all, so this stopReason check is the ONLY signal the protocol gives us for gating extraction.
// A structured report must NEVER be extracted from a message that wasn't confirmed complete: a truncated
// JSON object whose braces happen to still balance would otherwise PARSE successfully and be silently
// accepted as a real report - worse than a loud failure, since nothing would ever surface the truncation.
// `cancelled` and `refusal` are handled separately above this map (they are not "incomplete", they are
// different outcomes entirely). Any stop reason NOT in this known set (e.g. one a future protocol version
// adds) is treated the same as a known-incomplete reason - fail closed, never assume a stop reason we
// don't recognise is safe to parse.
const INCOMPLETE_STOP_REASONS = {
  max_tokens: 'ran out of tokens before finishing its report',
  max_turn_requests: 'exceeded its per-turn model-request limit before finishing its report',
};

export class CopilotRuntime extends Runtime {
  constructor({ executable = 'copilot', args = [], model, timeoutMs = 45 * 60 * 1000, permissionPolicy, defaultPermissionDecision, unhandledRequestTimeoutMs } = {}) {
    super({ command: executable, args: [...args, '--acp'], env: process.env, unavailableCode: 'copilot_unavailable', permissionPolicy, defaultPermissionDecision, unhandledRequestTimeoutMs });
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.turns = new Map();
    this.sessions = new SessionRegistry();
    this.agentCapabilities = {};
    this.authMethods = [];
    // sessionId -> advertised slash-command list (see onNotification's available_commands_update handling).
    this.commands = new Map();
  }

  /** See src/capabilities.mjs; every parity-surface method below is backed by one of these. */
  // eslint-disable-next-line class-methods-use-this
  capabilities() {
    return {
      setModel: true, releaseSession: true, setMode: true, setPermissions: true, setGoal: true, compact: true,
      usage: true, steer: false, fork: true, listSessions: true, resume: true, streaming: true, richPrompt: true,
      availableCommands: true,
      // S5: /fleet fans out parallel subagents INSIDE one session - a different shape from
      // src/fleet.mjs's fleet-of-sessions model (see fleetMode() below and the README).
      fleetMode: true,
      // S6: /every and /after are backend-side scheduling timers, not floe-runtime polling.
      scheduleRecurring: true, scheduleOnce: true,
    };
  }

  async handshake(peer) {
    this.sessions.clear();
    const info = await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'floe_runtime', title: 'Floe Runtime', version: '0.1.0' },
    });
    this.agentCapabilities = info.agentCapabilities || {};
    this.authMethods = info.authMethods || [];
    return info;
  }

  onNotification(message) {
    if (message.method !== 'session/update') return;
    const params = message.params || {};
    const update = params.update || {};
    if (update.sessionUpdate === 'available_commands_update') {
      this.commands.set(params.sessionId, update.availableCommands || []);
      return;
    }
    const task = this.turns.get(params.sessionId);
    const session = this.sessions.get(params.sessionId);
    // During resume()'s session/load replay there is no active turn (this.turns has no entry for the
    // session yet), but the replayed history must still surface as normalized activity/stream events
    // (marked `replay: true` via `this.replaying`, see Runtime#publish()) - fall back to the session
    // record's own correlation state so a caller sees the same normalized shape either way.
    if (!task && !session) return;
    const turnId = task?.turnId ?? null;
    if (task) task.lastActivity = Date.now();
    // Only 'agent_message_chunk' ("A chunk of the agent's response being streamed" - schema.json's
    // SessionUpdate $def) feeds the accumulated report text. 'agent_thought_chunk' ("A chunk of the
    // agent's internal reasoning being streamed" - same $def, a DIFFERENT sessionUpdate variant) is
    // deliberately not handled below at all, so the model's internal reasoning can never contaminate the
    // report channel - see test/copilot.test.mjs's thought-chunk-isolation test. `messageId` resets on
    // change per schema.json's ContentChunk $def: "A change in messageId indicates a new message has
    // started" - so only the LAST message's text is kept as the report, matching that semantics exactly.
    if (update.sessionUpdate === 'agent_message_chunk') {
      const delta = update.content?.text || '';
      if (task) {
        if (update.messageId !== task.messageId) { task.messageId = update.messageId; task.text = ''; }
        task.text += delta;
      }
      this.publish(params.sessionId, 'stream', { runtime: 'copilot', sessionId: params.sessionId, turnId, kind: 'text', delta, raw: message });
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (task) task.items.push(update);
      const activityMap = (task ?? session).activity ??= new Map();
      this.#trackToolCall(params.sessionId, activityMap, turnId, update);
      const outputDelta = Array.isArray(update.content) ? update.content.map(part => part.content?.text || part.text || '').join('') : '';
      if (outputDelta) this.publish(params.sessionId, 'stream', { runtime: 'copilot', sessionId: params.sessionId, turnId, kind: 'commandOutput', delta: outputDelta, raw: message });
    } else if (update.sessionUpdate === 'usage_update') {
      // P7 fix: the structured usage_update notification is the PRIMARY source for usage() - see usage()
      // below - not the /usage text reply, which is only a best-effort fallback for when no structured
      // update has arrived yet.
      const usage = { used: update.used, size: update.size, cost: update.cost || null };
      if (task) task.usage = usage;
      if (session) session.usage = usage;
      // S3: published as a normal event (never polled for) so a Fleet (or any consumer) can track
      // aggregate spend live - see src/fleet.mjs's budget admission control.
      this.publish(params.sessionId, 'usage', { runtime: 'copilot', sessionId: params.sessionId, ...usage });
    }
  }

  /**
   * Correlates ACP's tool_call (creation) + tool_call_update* (progress/terminal)
   * stream by toolCallId into the same normalized 'activity' events Codex
   * emits from its single item/started + item/completed pair. `activityMap` is either the active turn's
   * own correlation map, or (during a session/load replay with no active turn) the session record's.
   */
  #trackToolCall(sessionId, activityMap, turnId, update) {
    const toolCallId = update.toolCallId;
    if (!toolCallId) return;
    let record = activityMap.get(toolCallId);
    if (!record) {
      record = { kind: acpActivityKind(update.kind), title: update.title || toolCallId, command: update.rawInput?.command || null, startedAt: Date.now() };
      activityMap.set(toolCallId, record);
      this.publish(sessionId, 'activity', { runtime: 'copilot', sessionId, turnId, id: toolCallId, kind: record.kind, status: 'started', title: record.title, command: record.command, startedAt: record.startedAt, endedAt: null, raw: update });
    } else {
      if (update.kind) record.kind = acpActivityKind(update.kind);
      if (update.title) record.title = update.title;
      if (update.rawInput?.command) record.command = update.rawInput.command;
    }
    if (update.status === 'completed' || update.status === 'failed') {
      activityMap.delete(toolCallId);
      this.publish(sessionId, 'activity', { runtime: 'copilot', sessionId, turnId, id: toolCallId, kind: record.kind, status: update.status, title: record.title, command: record.command, startedAt: record.startedAt, endedAt: Date.now(), raw: update });
    }
  }

  onLost() {
    this.sessions.clear();
    for (const task of this.turns.values()) { clearTimeout(task.timer); task.reject(new RuntimeFault('copilot_disconnected', 'Copilot ACP server disconnected.', 503)); }
    this.turns.clear();
  }

  /**
   * Normalizes ACP's session/request_permission into the same backend-neutral
   * permission-request shape Codex uses. ACP option kinds (allow_once,
   * allow_always, reject_once, reject_always) already match our decision
   * vocabulary 1:1.
   */
  normalizePermissionRequest(message) {
    if (message.method !== 'session/request_permission') return null;
    const p = message.params || {};
    return {
      runtime: 'copilot', sessionId: p.sessionId, id: p.toolCall?.toolCallId || null,
      title: p.toolCall?.title || 'Permission requested', kind: acpActivityKind(p.toolCall?.kind),
      options: (p.options || []).map(option => ({ id: option.optionId, decision: option.kind, label: option.name })), raw: message,
    };
  }

  /** Translates a resolved decision back into ACP's session/request_permission response shape. */
  resolvePermissionRequest(message, decision) {
    const p = message.params || {};
    const options = (p.options || []).map(option => ({ id: option.optionId, decision: option.kind }));
    if (decision === 'cancel') { this.respond(message.id, { outcome: { outcome: 'cancelled' } }); return; }
    const option = pickOption(options, decision);
    if (!option) { this.respond(message.id, { outcome: { outcome: 'cancelled' } }); return; }
    this.respond(message.id, { outcome: { outcome: 'selected', optionId: option.id } });
  }

  /** Lists the models available on the authenticated Copilot account, as reported by session/new. */
  async models(cwd = process.cwd()) {
    await this.start();
    const result = await this.request('session/new', { cwd, mcpServers: [] });
    // The probe session is not tracked for reuse/quiesce; discard its id immediately.
    if (this.agentCapabilities.sessionCapabilities?.close) await this.request('session/close', { sessionId: result.sessionId }).catch(() => {});
    // The real session/new result shape is `models: { availableModels: [...], currentModelId }`,
    // an object wrapper, not a bare array - normalize it here so callers always get an array.
    const models = result.models;
    if (Array.isArray(models)) return models;
    return models?.availableModels || result.availableModels || [];
  }

  /**
   * Runs one prompt turn.
   * @param {string} role - caller-defined role label, used only for error messages/report validation.
   * @param {{prompt: string, schema?: object}} input - the fully-built prompt text (should itself request
   *   JSON matching `schema`, e.g. via schema.mjs#promptInstructionFor) and optional output JSON Schema.
   *   F8: prompt text is sent to Copilot VERBATIM, exactly as if a human had typed it into the CLI -
   *   floe-runtime never sanitizes, escapes, or intercepts a leading slash command. This matters because
   *   Copilot treats slash commands as ordinary prompt text (see the module header and availableCommands()
   *   below): a bare `/goal` does NOT print help, it immediately switches the session into autopilot mode.
   *   Callers composing prompts programmatically must account for this themselves.
   * @param {string} cwd
   * @param {(sessionId: string, meta: object) => Promise<void>|void} onStart
   * @param {{model?, timeoutMs?, mcpServers?}} settings
   * @param {{sessionId?, scope?, reason?, resumable?}} continuation - reuse hint from a previous run(). The
   *   caller must have called quiesce(sessionId) since the last run() for the session to be eligible for
   *   in-memory reuse. If `sessionId` is not one this runtime INSTANCE created (e.g. the app restarted),
   *   and the agent advertises loadSession, run() automatically calls resume() first to reconstruct
   *   tracking before continuing - pass `continuation.resumable: false` to opt out and force a fresh
   *   session instead (see PART 2 of the README on conversation lifetime).
   */
  async run(role, input, cwd, onStart = () => {}, settings = {}, continuation = {}) {
    await this.start();
    const model = Object.hasOwn(settings, 'model') ? settings.model : this.model;
    const timeoutMs = settings.timeoutMs || this.timeoutMs;
    // permissions is deliberately null here, unlike the Codex adapter: ACP has no
    // session-scoped permission profile - session/new takes no approval/sandbox
    // params, and every tool call is instead approved individually via
    // session/request_permission (see normalizePermissionRequest() above). There
    // is therefore no backend-level permission *state* that distinguishes one
    // reusable session from another. If a caller's permissionPolicy itself
    // varies in a way that should invalidate reuse (e.g. a stricter policy
    // version), fold that identity into `settings` - settings IS hashed into
    // this key - since permissionPolicy is a runtime-level constructor option,
    // not a per-call one, and floe-runtime cannot see inside it.
    const key = sessionKey({ role, cwd, model, settings, permissions: null, scope: continuation.scope });
    let sessionId = continuation.sessionId;
    let reused = false;
    let resumedNow = false;
    let reason = continuation.reason || 'A fresh session was requested.';
    // PART 2: a conversation stays alive across app restarts until the caller explicitly retires it.
    // If this sessionId is not one this runtime INSTANCE is tracking (e.g. a fresh process resuming
    // work from a previous run, discovered via listSessions()), reconstruct tracking via resume() before
    // deciding whether it is reusable, rather than treating an unknown sessionId as unavailable.
    if (sessionId && !this.sessions.has(sessionId) && continuation.resumable !== false && this.agentCapabilities.loadSession) {
      try { await this.resume(sessionId, cwd, settings.mcpServers || []); resumedNow = true; }
      catch (error) { this.emit('diagnostic', `Could not resume session ${sessionId}: ${error.message}`); }
    }
    if (sessionId && (resumedNow || this.sessions.isReusable(sessionId, key))) {
      reused = true;
      // A caller explicitly asking to resume THIS session wins over key-matching (which only applies to
      // "give me any session that matches settings X") - adopt this call's key now that it is known, so
      // later run()s against the same sessionId reuse normally for the rest of this process's lifetime.
      // This also covers the caller having called resume() itself BEFORE run() (rather than run()
      // auto-resuming) - resume() leaves key:null precisely so the first run() afterwards claims it.
      if (resumedNow || this.sessions.get(sessionId).key == null) this.sessions.get(sessionId).key = key;
    } else if (sessionId) {
      reason = this.sessions.has(sessionId) ? 'The destination or session settings changed.' : 'The runtime restarted or the previous session is unavailable.';
      sessionId = null;
    }
    if (!reused) {
      const created = await this.request('session/new', { cwd, mcpServers: settings.mcpServers || [] });
      sessionId = created.sessionId;
      this.sessions.set(sessionId, { key, result: created, currentModelId: created.models?.currentModelId ?? null });
    } else {
      this.sessions.get(sessionId).stopped = false;
    }
    // B1 fix: session/new silently ignores a `model` param (verified live - the
    // returned currentModelId does not change), so an explicitly requested model
    // must be applied with a follow-up session/set_model call, on both a fresh
    // and a reused session.
    if (model && this.sessions.get(sessionId)?.currentModelId !== model) await this.setModel(sessionId, model);
    check(!this.turns.has(sessionId), 'turn_busy', 'The session already has an active turn.', 409);
    let settleResolve;
    let settleReject;
    const completion = new Promise((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
    const expire = () => { this.interrupt(sessionId).catch(() => {}); settleReject(new RuntimeFault('turn_timeout', `${role} reached its ${Math.round(timeoutMs / 60000)} minute task limit. Review its activity before resuming.`, 408)); };
    const timer = setTimeout(expire, timeoutMs);
    this.turns.set(sessionId, {
      role, schema: input.schema, started: Date.now(), items: [], text: '', messageId: null, usage: null,
      // ACP has no native turn id; synthesize one so activity/permission events carry the same turnId
      // field shape a Codex consumer already expects.
      turnId: id('turn'),
      timer, expire, resolve: settleResolve, reject: settleReject, lastActivity: Date.now(),
      // quiesce() awaits this settlement promise directly instead of polling `this.turns.has(sessionId)`
      // on a timer (PART 1: no polling anywhere).
      settlement: completion,
    });
    completion.catch(() => {});
    try {
      const task = this.turns.get(sessionId);
      this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'started' });
      await onStart(sessionId, {
        model: this.sessions.get(sessionId)?.currentModelId || model || null, runtimeInstance: null,
        session: { action: reused ? 'reused' : continuation.sessionId ? 'refreshed' : 'fresh', reason: reused ? 'Continuing the same session.' : reason },
      });
      // P13: a caller may pass structured prompt content blocks (e.g. image,
      // embedded-context - Copilot advertises promptCapabilities.image/
      // embeddedContext) via input.blocks; otherwise fall back to a single
      // text block built from input.prompt. floe-runtime passes blocks
      // straight through untouched - it does not translate block shapes
      // between backends, since ACP and Codex content blocks are not identical.
      const prompt = input.blocks || [{ type: 'text', text: input.prompt }];
      const response = await this.request('session/prompt', { sessionId, prompt }, timeoutMs + 5000);
      const finishingTask = this.turns.get(sessionId);
      if (finishingTask) this.#finishTurn(sessionId, finishingTask, response.stopReason);
    } catch (error) {
      const task = this.turns.get(sessionId);
      if (task) { clearTimeout(task.timer); this.turns.delete(sessionId); task.reject(error); }
      throw error;
    }
    return completion;
  }

  /** P1 / B1 fix: applies a model to a session. session/new itself ignores a model param. */
  async setModel(sessionId, modelId) {
    await this.start();
    await this.request('session/set_model', { sessionId, modelId });
    const session = this.sessions.get(sessionId);
    if (session) session.currentModelId = modelId;
  }

  /** P3: switches the session's ACP mode (interactive/plan/autopilot) via session/set_mode. */
  async setMode(sessionId, mode) {
    await this.start();
    const modeId = MODE_URIS[mode];
    check(modeId, 'invalid_mode', `Unknown session mode '${mode}'.`, 400);
    await this.request('session/set_mode', { sessionId, modeId });
  }

  /**
   * P4: sets the session's permission posture via Copilot's control commands
   * (there is no JSON-RPC method for this - it is only exposed as advertised
   * slash commands sent through session/prompt, see the module header).
   * 'read-only' has no working Copilot equivalent (there is no documented
   * deny-by-default mode, only "ask" and "allow all") - this deliberately
   * throws rather than silently downgrading to 'prompt'.
   */
  async setPermissions(sessionId, level) {
    if (level === 'allow-all') return this.#runControlCommand(sessionId, '/allow-all on');
    if (level === 'prompt') return this.#runControlCommand(sessionId, '/permissions default');
    unsupported('copilot', "setPermissions('read-only')");
    return undefined;
  }

  /** P5: sets or clears an autopilot objective via the /autopilot control command. opts.maxCredits is Copilot-only. */
  async setGoal(sessionId, objective, opts = {}) {
    const credits = opts.maxCredits != null ? ` --max-ai-credits ${opts.maxCredits}` : '';
    const text = objective == null ? '/autopilot off' : `/autopilot ${objective}${credits}`;
    return this.#runControlCommand(sessionId, text);
  }

  /** P6: summarizes conversation history via the /compact control command. */
  async compact(sessionId, focus = '') {
    return this.#runControlCommand(sessionId, focus ? `/compact ${focus}` : '/compact');
  }

  /**
   * P7: reports session usage. PRIMARY source is the structured `usage_update` session/update
   * notification (see onNotification's `used`/`size`/`cost` handling) - it is pushed by the agent, not
   * parsed from prose, so it is the reliable source whenever it has been observed for this session.
   * FALLBACK ONLY: if no usage_update has arrived yet, this runs `/usage` (which itself typically
   * triggers a usage_update as a side effect - re-checked afterwards) and, failing that, best-effort
   * regex-parses its plain-text reply. Regex-parsing prose is too fragile to be the primary path.
   */
  async usage(sessionId) {
    const known = this.sessions.get(sessionId)?.usage;
    if (known) return { backend: 'copilot', ...known, raw: known };
    const result = await this.#runControlCommand(sessionId, '/usage');
    const observed = this.sessions.get(sessionId)?.usage;
    if (observed) return { backend: 'copilot', ...observed, raw: observed };
    return { backend: 'copilot', requests: extractCount(result.text, 'Requests'), aiUnits: extractCount(result.text, 'AI Units'), raw: result.text };
  }

  /** P8: Copilot has no turn-steering equivalent to Codex's turn/steer - a running prompt cannot be redirected. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async steer(sessionId, text) { unsupported('copilot', 'steer'); }

  /** P9: forks the session via session/fork. */
  async fork(sessionId) {
    await this.start();
    return this.request('session/fork', { sessionId });
  }

  /** P10: lists known sessions via session/list. */
  async listSessions() {
    await this.start();
    const result = await this.request('session/list', {});
    return result.data || result.sessions || [];
  }

  /** P14: the slash-command list Copilot advertised for this session via available_commands_update.
   * F7: this is a UI HINT ONLY, not authoritative - it is confirmed that `/goal` works over ACP despite
   * never appearing in available_commands_update. Never gate whether a command can be executed on
   * whether it shows up here; only use this list to populate a menu/autocomplete for a human. */
  availableCommands(sessionId) {
    return this.commands.get(sessionId) || [];
  }

  /**
   * S5: fans out parallel subagents INSIDE this single session via the /fleet control command
   * ("Enable fleet mode for parallel subagent execution", hint "prompt"). This is a DIFFERENT swarm
   * shape from src/fleet.mjs's Fleet class (a pool of independent sessions, each with its own
   * conversation): /fleet suits a short parallel burst that shares one context window, while
   * src/fleet.mjs's fleet-of-sessions model suits long-lived independent agents with separate
   * conversations that must be individually resumable. Codex has no equivalent - see
   * CodexRuntime#fleetMode().
   */
  async fleetMode(sessionId, prompt) {
    return this.#runControlCommand(sessionId, `/fleet ${prompt}`);
  }

  /** S6: schedules a recurring prompt/skill for this session via the backend-side /every timer -
   * Copilot wakes itself; floe-runtime does not poll for it. */
  async scheduleRecurring(sessionId, interval, prompt) {
    return this.#runControlCommand(sessionId, `/every ${interval} ${prompt}`);
  }

  /** S6: schedules a one-shot prompt/skill for this session via the backend-side /after timer -
   * Copilot wakes itself; floe-runtime does not poll for it. */
  async scheduleOnce(sessionId, delay, prompt) {
    return this.#runControlCommand(sessionId, `/after ${delay} ${prompt}`);
  }

  /**
   * Orphan sweep (see PART 2 in the README): closes sessions this runtime instance is not tracking
   * (`this.sessions`) that session/list reports as idle for longer than `maxAgeMs` (default 21 days - a
   * generous window). Never sweeps a session this instance still owns, and never sweeps one whose
   * last-activity timestamp is unknown (safer to leave an unaged session alone than wrongly close it).
   */
  async sweepOrphans({ maxAgeMs = 21 * 24 * 60 * 60 * 1000 } = {}) {
    await this.start();
    const cutoff = Date.now() - maxAgeMs;
    const sessions = await this.listSessions();
    const swept = [];
    for (const session of sessions) {
      const sessionId = session.sessionId || session.id;
      if (!sessionId || this.sessions.has(sessionId)) continue;
      const lastActivity = Date.parse(session.updatedAt || session.lastActivityAt || '');
      if (Number.isNaN(lastActivity)) { this.emit('diagnostic', `sweepOrphans: session ${sessionId} has no known last-activity timestamp; leaving it alone.`); continue; }
      if (lastActivity > cutoff) continue;
      try { await this.request('session/close', { sessionId }); swept.push(sessionId); }
      catch (error) { this.emit('diagnostic', `sweepOrphans: could not close session ${sessionId}: ${error.message}`); }
    }
    return { swept, checked: sessions.length };
  }

  /**
   * Sends a Copilot control command (e.g. /usage, /compact, /autopilot) as
   * ordinary prompt text. These are LOCAL operations (verified live - /usage
   * reports "Requests: 0 AI Units" for itself) so they intentionally bypass
   * the schema-validated run() path and just collect the raw reply text.
   */
  async #runControlCommand(sessionId, text) {
    await this.start();
    check(!this.turns.has(sessionId), 'turn_busy', 'The session already has an active turn.', 409);
    const task = { role: 'control', schema: null, started: Date.now(), items: [], text: '', messageId: null, usage: null, turnId: id('turn'), timer: null, expire: () => {}, lastActivity: Date.now() };
    this.turns.set(sessionId, task);
    let response;
    try {
      response = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 60000);
    } finally {
      this.turns.delete(sessionId);
    }
    return { text: task.text, stopReason: response.stopReason };
  }

  #finishTurn(sessionId, task, stopReason) {
    this.turns.delete(sessionId);
    clearTimeout(task.timer);
    if (stopReason === 'cancelled') {
      this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'interrupted', stopReason });
      task.reject(new RuntimeFault('interrupted', 'Turn was cancelled.', 409));
      return;
    }
    if (stopReason === 'refusal') {
      // F9 (Copilot side, best-effort/UNCONFIRMED): the user could not confirm ACP's exact quota/limit
      // refusal shape without live access. Until confirmed, this heuristically inspects the accumulated
      // agent message text for quota/credit/spend-cap language and, if it matches, raises the SAME
      // 'usage_limit_exceeded' fault as the confirmed Codex path (see codex.mjs's #completeTurn) so an
      // app has one consistent fault regardless of backend - but this is a guess, not a verified mapping.
      // Extension point: replace/extend #looksLikeUsageLimit once the real shape (a specific stopReason,
      // an error response, or a structured field) is observed live.
      if (looksLikeUsageLimit(task.text)) {
        const reason = 'The Copilot agent refused to continue; the message suggests a usage/quota/spend limit was hit (unconfirmed heuristic - see F9 comment).';
        this.publish(sessionId, 'budgetCeilingReached', { runtime: 'copilot', sessionId, source: 'backend', reason });
        task.reject(new RuntimeFault('usage_limit_exceeded', reason, 402));
        return;
      }
      this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'failed', stopReason });
      task.reject(new RuntimeFault('turn_failed', 'The agent refused to continue.', 409));
      return;
    }
    try {
      let report;
      if (task.schema) {
        // Only `end_turn` confirms the agent's final message is actually complete (see
        // INCOMPLETE_STOP_REASONS above) - extraction must never run against a message the protocol
        // itself told us was cut off, or one stopped for a reason this adapter doesn't recognise.
        if (stopReason !== 'end_turn') {
          const detail = INCOMPLETE_STOP_REASONS[stopReason]
            || `stopped for a stop reason this adapter does not recognise (stopReason: ${stopReason}) - its message cannot be confirmed complete`;
          throw new RuntimeFault('report_incomplete', `The ${task.role} ${detail} (stopReason: ${stopReason}). This is not malformed output - the agent was cut off before it could finish; do not treat this as an invalid report.`, 502);
        }
        report = extractStructuredOutput(task.text, task.schema, { role: task.role });
      } else {
        report = task.text;
      }
      this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'completed', stopReason });
      task.resolve({ report, text: task.text, sessionId, turnId: task.turnId, stopReason, items: task.items, usage: task.usage, elapsedMs: Date.now() - task.started });
    } catch (error) {
      this.publish(sessionId, 'turn', { runtime: 'copilot', sessionId, turnId: task.turnId, phase: 'failed', stopReason });
      task.reject(error);
    }
  }

  /** Sends session/cancel; the in-flight session/prompt response (stopReason 'cancelled') settles the turn. */
  async interrupt(sessionId) {
    if (!this.turns.has(sessionId)) return;
    this.notify('session/cancel', { sessionId });
  }

  /** Interrupts any active turn and waits for its settlement promise (never a membership-polling loop -
   * PART 1: no polling anywhere). ACP has no background-terminal enumeration to check. */
  async quiesce(sessionId) {
    const task = this.turns.get(sessionId);
    if (task) {
      await this.interrupt(sessionId);
      await Promise.race([
        task.settlement.catch(() => {}),
        new Promise((resolve, reject) => setTimeout(() => reject(new RuntimeFault('quiescence_unknown', 'The active turn has not confirmed interruption.', 409)), 10000)),
      ]);
    }
    this.sessions.markStopped(sessionId);
  }

  /** Deletes the session if the agent advertises sessionCapabilities.close, otherwise retires it locally only. */
  async retire(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'unavailable' };
    check(session.stopped && !this.turns.has(sessionId), 'quiescence_unknown', 'Confirm the assignment stopped before retiring its session.', 409);
    this.sessions.delete(sessionId);
    // Confirmed via live probe: agentCapabilities.sessionCapabilities is exactly
    // { close: {}, list: {} } - there is no `delete` key, and `session/delete`
    // itself does not exist on the wire (-32601). The correct method is `session/close`.
    if (!this.agentCapabilities.sessionCapabilities?.close) {
      this.emit('diagnostic', 'The stopped session was retired locally; the agent does not advertise session/close.');
      return { status: 'retiredLocally' };
    }
    try {
      await this.request('session/close', { sessionId });
      return { status: 'deleted' };
    } catch (error) {
      this.emit('diagnostic', 'The stopped session was retired locally; session/close failed: ' + error.message);
      return { status: 'retiredLocally', reason: error.message };
    }
  }

  /**
   * PART 2: this is the app-restart recovery path - loads a previously known session via session/load,
   * replaying its full history as `session/update` notifications, only if the agent advertises the
   * loadSession capability (confirmed advertised). run() calls this automatically when handed a
   * sessionId it is not already tracking (see run()'s `resumedNow` handling above); it can also be
   * called directly to discover-and-reconnect after a process restart (pair with listSessions()).
   *
   * PART 3 (replay marking): session/load replays the ENTIRE conversation history back as ordinary
   * `session/update` notifications, indistinguishable on the wire from live activity. While the
   * response is in flight, this sessionId is added to `this.replaying` so every 'activity'/'stream'
   * event onNotification publishes during that window is marked `replay: true` (see Runtime#publish());
   * once session/load resolves (all replayed notifications for a JSON-RPC subprocess arrive strictly
   * before its response), a final `replayComplete` event signals the transition back to live.
   */
  async resume(sessionId, cwd, mcpServers = [], opts = {}) {
    await this.start(); // must handshake first - agentCapabilities.loadSession is only known after initialize()
    check(this.agentCapabilities.loadSession, 'load_session_unsupported', 'This Copilot agent does not support session/load.', 501);
    this.replaying.add(sessionId);
    // Pre-register the session BEFORE session/load so onNotification has somewhere to correlate
    // tool_call/tool_call_update history against while it is replayed (see onNotification above).
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { key: null, result: { sessionId }, instanceId: null });
    try {
      await this.request('session/load', { sessionId, cwd, mcpServers });
      this.sessions.markStopped(sessionId);
      // F11 symmetry: unconfirmed whether Copilot's session/load has the same goal-loss behavior Codex's
      // thread/resume does, but this defensively re-applies a caller-supplied last-known goal for API
      // parity across both adapters rather than assuming Copilot is unaffected.
      if (opts.goal != null) {
        try {
          await this.setGoal(sessionId, opts.goal);
          this.publish(sessionId, 'goalReapplied', { sessionId, objective: opts.goal });
        } catch (error) {
          this.emit('diagnostic', `Could not re-apply objective after resume(): ${error.message}`);
          this.publish(sessionId, 'goalReapplyFailed', { sessionId, objective: opts.goal, reason: error.message });
        }
      }
      return sessionId;
    } finally {
      this.replaying.delete(sessionId);
      this.publish(sessionId, 'replayComplete', { sessionId });
    }
  }

  async onClosing() {
    for (const sessionId of this.turns.keys()) await this.interrupt(sessionId).catch(() => {});
  }

  async close() {
    await super.close();
    this.sessions.clear();
  }
}
