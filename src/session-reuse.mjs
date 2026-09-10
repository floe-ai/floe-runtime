// Generalized session-reuse bookkeeping, shared by every adapter.
//
// The actual "is this session still safely reusable right now" check is
// backend-specific (Codex confirms via thread/read, Copilot has no such
// call and must rely on its own in-memory state) - this module only owns
// the reuse *key* derivation and a small registry of known sessions, mirroring
// the `this.sessions` Map pattern in star-map's codex.mjs.
import { digest } from './errors.mjs';

/**
 * Derives a stable reuse key from everything that must match for a session
 * to be safely reused: role, working directory, model, arbitrary settings,
 * computed permissions, and an optional caller-supplied scope (e.g. a hash
 * of the issue/task being worked on).
 */
export function sessionKey({ role, cwd, model, settings, permissions, scope }) {
  return digest(JSON.stringify({ role, cwd, model, settings, permissions, scope }));
}

/** Tracks live backend sessions (threadId/sessionId -> { key, stopped, result, instanceId }). */
export class SessionRegistry {
  constructor() {
    this.sessions = new Map();
  }

  set(sessionId, { key, result, instanceId = null, ...extra } = {}) {
    this.sessions.set(sessionId, { key, result, stopped: false, instanceId, ...extra });
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  /** Marks a session as having confirmed a clean stop (required before reuse or retirement). */
  markStopped(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.stopped = true;
  }

  delete(sessionId) {
    this.sessions.delete(sessionId);
  }

  clear() {
    this.sessions.clear();
  }

  /** True when `sessionId` is known, confirmed stopped, and matches `key` - i.e. safe to reuse. An entry
   * with `key === null` (freshly resume()d, but never yet claimed by a run() call) is reusable by ANY
   * key - the first run() call after an explicit resume() adopts that key, exactly like an
   * automatically-resumed session already does. Without this, a caller that calls resume() itself
   * (rather than letting run() auto-resume an unknown sessionId) could never reuse the restored session -
   * every subsequent run() would silently start a brand-new one and the "resumed" conversation would be
   * discarded unused. */
  isReusable(sessionId, key) {
    const entry = this.sessions.get(sessionId);
    return !!entry && entry.stopped === true && (entry.key === null || entry.key === key);
  }
}
