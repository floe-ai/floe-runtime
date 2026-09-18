// Shared base class for protocol-specific Runtime adapters (Codex, Copilot).
//
// Owns: subprocess lifecycle (spawn once, dedupe concurrent start() calls),
// wiring a JsonRpcPeer's diagnostic/notification/request/exit/error events
// into the public Runtime event surface, and the connection-lost/close
// bookkeeping every adapter needs. Adapters implement the abstract hooks
// below to supply their own handshake and turn/session semantics; they must
// still implement run()/interrupt()/quiesce()/retire() themselves since those
// differ too much between Codex's thread/turn model and Copilot's SDK session
// model to usefully share.
//
// Public Runtime interface (implemented by every adapter):
//   start()                                                  -> Promise<info>
//   run(role, context, cwd, onStart, settings, continuation) -> Promise<result>
//   interrupt(sessionId)                                     -> Promise<void>
//   quiesce(sessionId, options)                               -> Promise<void>
//   retire(sessionId)                                        -> Promise<{status}>
//   close()                                                  -> Promise<void>
//   -- parity surface (see src/capabilities.mjs; throws capability_unsupported
//      when the backend has no native equivalent) --
//   setModel(sessionId, modelId), releaseSession(sessionId), setMode(sessionId, mode),
//   setPermissions(sessionId, level), setGoal(sessionId, objective, opts), compact(sessionId, focus),
//   usage(sessionId), steer(sessionId, text), fork(sessionId), listSessions(),
//   resume(sessionId), availableCommands(sessionId), sweepOrphans(options)
// Events: 'ready' (info), 'lost' (error), 'diagnostic' (text), 'notification' (message),
//   'request' (message), 'activity' (event), 'stream' (event - live text/reasoning/command output),
//   'event' (a JSON-safe, sequence-numbered envelope of every activity/stream/turn/replay event - see
//   src/events.mjs and Runtime#events()/#publish())
//
// Conversation lifetime: a conversation is persistent by default and stays resumable (across process
// restarts, via resume()) until the caller explicitly retire()s it - a completed turn never ends or
// deletes a session. See the README's "Conversation lifetime and resumability" section.
import { EventEmitter } from 'node:events';
import { JsonRpcPeer } from './jsonrpc.mjs';
import { RuntimeFault } from './errors.mjs';
import { EventLog, watchEvents } from './events.mjs';

// A permission request that nobody answers must never hang a turn forever.
// This is a last-resort safety net on top of the immediate policy/default
// handling in #handlePermission - it also covers request types an adapter
// does not normalize as a permission (see normalizePermissionRequest()).
const DEFAULT_UNHANDLED_REQUEST_TIMEOUT_MS = 20000;
// Deny-by-default: an unanswered permission request risks the agent running
// a tool/command the caller never actually reviewed. A silent implicit
// allow is unsafe; an instant, deterministic deny is always safe and never
// depends on timing. Callers that want different behaviour must say so
// explicitly via `permissionPolicy` or `defaultPermissionDecision`.
const DEFAULT_PERMISSION_DECISION = 'reject_once';

export class Runtime extends EventEmitter {
  constructor({
    command, args = [], env = process.env, unavailableCode = 'runtime_unavailable',
    permissionPolicy = null, defaultPermissionDecision = DEFAULT_PERMISSION_DECISION,
    unhandledRequestTimeoutMs = DEFAULT_UNHANDLED_REQUEST_TIMEOUT_MS, replayBufferSize,
  } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.unavailableCode = unavailableCode;
    this.ready = false;
    this.peer = null;
    this.starting = null;
    this.closing = false;
    this.losing = false;
    this.info = null;
    this.permissionPolicy = permissionPolicy;
    this.defaultPermissionDecision = defaultPermissionDecision;
    this.unhandledRequestTimeoutMs = unhandledRequestTimeoutMs;
    // Every emitted event is also wrapped into a JSON-safe, sequence-numbered
    // envelope and buffered per conversationId (see src/events.mjs) so a
    // resuming app can replay what it missed instead of losing it silently.
    this.eventLog = new EventLog(replayBufferSize);
    // conversationId -> true while an adapter is replaying stored history
    // (Copilot's session/load, Codex's thread/resume snapshot) back to the
    // caller; publish() marks every envelope emitted during that window as
    // `replay: true` so a resuming consumer never mistakes old activity for
    // something happening live (e.g. re-running a side effect).
    this.replaying = new Set();
  }

  /** Spawns the subprocess and performs the protocol handshake (idempotent, concurrency-safe). */
  async start() {
    if (this.ready) return this.info;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.closing = false;
      const peer = new JsonRpcPeer({ command: this.command, args: this.args, env: this.env, unavailableCode: this.unavailableCode });
      peer.on('diagnostic', text => this.emit('diagnostic', text));
      peer.on('notification', message => this.#onNotification(message));
      peer.on('request', message => this.#onRequest(message));
      peer.on('error', error => this.#lost(new RuntimeFault(this.unavailableCode, `${this.command} could not start: ${error.message}.`, 503)));
      peer.on('exit', (code, signal) => {
        if (this.peer !== peer) return;
        this.#lost(new RuntimeFault(`${this.unavailableCode}`, `${this.command} exited (${signal || code}).`, 503));
      });
      this.peer = peer;
      peer.spawn();
      this.info = await this.handshake(peer);
      this.ready = true;
      this.emit('ready', this.info);
      return this.info;
    })();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  /** Adapter hook: perform the protocol-specific initialize handshake and return an info object. */
  // eslint-disable-next-line class-methods-use-this
  async handshake() {
    throw new RuntimeFault('not_implemented', 'Runtime subclasses must implement handshake().', 500);
  }

  /** Adapter hook: handle an inbound JSON-RPC notification from the subprocess. */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  onNotification(message) { /* no-op by default */ }

  /** Adapter hook: handle an inbound JSON-RPC request from the subprocess (e.g. permission prompts). */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  onRequest(message) { /* no-op by default */ }

  /** Adapter hook: reset any in-memory session/turn state after the connection is lost. */
  // eslint-disable-next-line class-methods-use-this
  onLost() { /* no-op by default */ }

  /** Adapter hook: interrupt any active turns before the subprocess is terminated in close(). */
  // eslint-disable-next-line class-methods-use-this
  async onClosing() { /* no-op by default */ }

  /**
   * Adapter hook: normalize an inbound request into a backend-neutral permission
   * request (see permissions.mjs), or return null if this message is not one
   * (e.g. a data-form elicitation with no yes/no decision, or an unrelated
   * request type). Only messages this returns non-null for are auto-answered
   * by the policy/default path below.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  normalizePermissionRequest(message) { return null; }

  /** Adapter hook: translate a resolved decision back into the backend's wire response and respond(). */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  resolvePermissionRequest(message, decision) { /* no-op by default */ }

  /**
   * Declares which of the parity-surface methods (setModel, setMode, setPermissions,
   * setGoal, compact, usage, steer, fork, listSessions, resume, streaming,
   * richPrompt, availableCommands; releaseSession is always supported, it is
   * just retire() under another name) this adapter backs natively. Consumers
   * can check this ahead of calling to avoid a capability_unsupported fault.
   * See src/capabilities.mjs for the full FEATURES list.
   */
  // eslint-disable-next-line class-methods-use-this
  capabilities() { return {}; }

  /** Alias for retire() under the parity-surface name (see capabilities.mjs P2). */
  releaseSession(sessionId) { return this.retire(sessionId); }

  /**
   * Publishes one backend-neutral event for `conversationId` (a threadId/sessionId): wraps `data` into a
   * JSON-safe, sequence-numbered envelope (see src/events.mjs), buffers it for replay, emits it on the
   * unified `'event'` stream, AND emits it under its own `type` (e.g. `'activity'`, `'stream'`) for
   * backward-compatible named-event listeners. `replay` defaults to whether this conversationId is
   * currently in `this.replaying` (see resume()/session-load-driven history flows in each adapter).
   */
  publish(conversationId, type, data, { replay } = {}) {
    const envelope = this.eventLog.publish(conversationId, type, data, { replay: replay ?? this.replaying.has(conversationId) });
    this.emit('event', envelope);
    this.emit(type, data);
    return envelope;
  }

  /**
   * An async-iterable live feed of every event published for `conversationId`, so a consumer can
   * `for await (const envelope of runtime.events(sessionId))` over a turn's activity/stream/lifecycle
   * without correlating ids by hand. Replays buffered history first (see EventLog#since()), signalling a
   * `'gap'` envelope if `since` has already fallen out of the bounded buffer, then yields live events
   * until the caller stops iterating or the runtime disconnects.
   */
  events(conversationId, options) {
    return watchEvents(this, conversationId, options);
  }

  /**
   * Adapter hook: releases backend sessions/threads this runtime instance did not create or is no longer
   * tracking, if they have been idle beyond `maxAgeMs` (see each adapter's implementation using its own
   * listSessions()). This is the orphan-crash safety net described in the package README's Conversation
   * lifetime section - it must never sweep anything still resumable within the window, and the default
   * window must be generous (weeks, not days).
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async sweepOrphans(options) {
    throw new RuntimeFault('not_implemented', 'Runtime subclasses must implement sweepOrphans().', 500);
  }

  #onNotification(message) {
    this.onNotification(message);
    this.emit('notification', message);
  }

  #onRequest(message) {
    this.onRequest(message);
    // Precedence: an explicit 'request' listener means the caller wants full
    // manual control - never auto-answer while one is attached. Otherwise
    // fall through to the caller's permissionPolicy, then the safe default.
    const normalized = this.listenerCount('request') === 0 ? this.normalizePermissionRequest(message) : null;
    if (normalized) this.#handlePermission(message, normalized).catch(error => this.emit('diagnostic', 'Permission handling failed: ' + error.message));
    this.emit('request', message);
    this.#armUnhandledRequestTimeout(message);
  }

  async #handlePermission(message, normalized) {
    let decision = null;
    if (this.permissionPolicy) {
      try { decision = await this.permissionPolicy(normalized); }
      catch (error) { this.emit('diagnostic', 'permissionPolicy threw; falling back to the default decision: ' + error.message); }
    }
    const valid = decision && (normalized.options.some(option => option.decision === decision) || decision === 'cancel');
    this.resolvePermissionRequest(message, valid ? decision : this.defaultPermissionDecision);
  }

  /** Last-resort safety net: any inbound request left unanswered after the timeout is auto-declined. */
  #armUnhandledRequestTimeout(message) {
    if (!this.peer) return;
    const requestId = String(message.id);
    const timer = setTimeout(() => {
      if (this.peer?.isAwaitingResponse(requestId)) {
        this.respondError(requestId, 'No permission policy or listener answered this runtime request in time; it was automatically declined.', -32000);
      }
    }, this.unhandledRequestTimeoutMs);
    timer.unref?.();
  }

  #lost(error) {
    if (this.losing) return;
    this.losing = true;
    this.ready = false;
    this.peer?.reset(error);
    this.onLost(error);
    if (!this.closing) this.emit('lost', error);
    this.losing = false;
  }

  /** Sends a JSON-RPC request to the subprocess. */
  request(method, params, timeoutMs) {
    if (!this.peer) return Promise.reject(new RuntimeFault(this.unavailableCode, `${this.command} is unavailable.`, 503));
    return this.peer.request(method, params, timeoutMs);
  }

  /** Sends a one-way JSON-RPC notification to the subprocess. */
  notify(method, params) {
    this.peer?.notify(method, params);
  }

  /** Responds to an inbound server-initiated request. */
  respond(requestId, result) {
    this.peer?.respond(requestId, result);
  }

  /** Responds to an inbound server-initiated request with an error. */
  respondError(requestId, message, code) {
    this.peer?.respondError(requestId, message, code);
  }

  /** Interrupts active work, then terminates the subprocess. Safe to call even if never started. */
  async close() {
    this.closing = true;
    await this.onClosing();
    if (this.peer) await this.peer.terminate();
    this.ready = false;
  }
}
