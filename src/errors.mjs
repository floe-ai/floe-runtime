// Shared error type and assertion helper used across the runtime core and
// every adapter. Mirrors the star-map `util.mjs` Fault/check() shape so
// consuming apps can rely on a stable { code, message, status } contract
// regardless of which backend (Codex, Copilot, ...) raised the error.

export class RuntimeFault extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'RuntimeFault';
    this.code = code;
    this.status = status;
  }
}

/** Throws a RuntimeFault when `condition` is falsy. */
export function check(condition, code, message, status = 500) {
  if (!condition) throw new RuntimeFault(code, message, status);
}

/** Generates a short unique id prefixed with `scope`, e.g. id('runtime') -> 'runtime_1a2b3c'. */
export function id(scope) {
  return `${scope}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Deterministic short digest of arbitrary JSON-serializable input, used for session-reuse keys. */
export function digest(text) {
  let hash = 0n;
  const prime = 1099511628211n;
  let offset = 14695981039346656037n;
  const bytes = Buffer.from(text, 'utf8');
  for (const byte of bytes) {
    offset ^= BigInt(byte);
    offset = (offset * prime) & 0xffffffffffffffffn;
  }
  hash = offset;
  return hash.toString(16).padStart(16, '0');
}

/** Truncates and redacts a raw stderr/stdout chunk before it is surfaced as a diagnostic event. */
export function redact(text, maxLength = 4000) {
  return String(text).slice(-maxLength);
}
