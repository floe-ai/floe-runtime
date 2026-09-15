// Backend-neutral permission-request normalization, shared by every
// adapter. Consuming apps write ONE policy function against this shape
// instead of separate code for Codex and Copilot SDK approval requests.
// `session/request_permission`:
//
//   normalized request: { runtime, sessionId, id, title, kind, options, raw }
//     - options: [{ id, decision, label }]  (id is the backend's own option
//       identifier, `decision` is one of PERMISSION_DECISIONS)
//   policy decision: one of PERMISSION_DECISIONS, returned by the caller's
//     permissionPolicy(request) function (sync or async)
//
// See runtime.mjs for how a policy/listener/default is selected, and
// adapters/codex.mjs + adapters/copilot.mjs for how a decision is translated
// back into each backend's wire response shape.
export const PERMISSION_DECISIONS = Object.freeze(['allow_once', 'allow_always', 'reject_once', 'reject_always', 'cancel']);

/** Finds the option matching a decision, by normalized decision first, then by the option's own id. */
export function pickOption(options, decision) {
  return options.find(option => option.decision === decision) || options.find(option => option.id === decision) || null;
}
