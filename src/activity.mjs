// Backend-neutral command/tool activity normalization, shared by every
// adapter. Consuming apps should never need to know whether a Codex
// `item/started`+`item/completed` pair or an ACP `tool_call`+`tool_call_update`
// sequence produced a given event - both adapters emit the same shape via
// the Runtime 'activity' event:
//
//   { runtime, sessionId, turnId, id, kind, status, title, command, startedAt, endedAt, raw }
//
// - runtime: 'codex' | 'copilot'
// - sessionId: Codex threadId or Copilot sessionId
// - turnId: the turn this activity belongs to (Codex's protocol turn id, or a
//   synthetic id the adapter assigns per run() call for backends with no
//   native turn id)
// - id: a stable identifier for this specific piece of activity (Codex
//   item.id, ACP toolCallId), used to correlate 'started' with its terminal
//   'completed'/'failed' event
// - kind: normalized into a small closed set so callers can render/filter
//   without a backend-specific switch statement
// - status: 'started' | 'completed' | 'failed' - collapses Codex's two
//   notifications and ACP's tool_call/tool_call_update stream into the same
//   three-state lifecycle
// - title/command: human-readable label and (if applicable) the literal
//   command line
// - startedAt/endedAt: epoch milliseconds; endedAt is null until the
//   terminal event
// - raw: the untouched backend notification, kept as an escape hatch for
//   callers that do need backend-specific detail

export const ACTIVITY_KINDS = Object.freeze(['command', 'file', 'search', 'fetch', 'think', 'tool', 'other']);
export const ACTIVITY_STATUSES = Object.freeze(['started', 'completed', 'failed']);

/** Maps a Codex `item.type` to a normalized activity kind. */
export function codexActivityKind(itemType) {
  switch (itemType) {
    case 'commandExecution': return 'command';
    case 'fileChange': return 'file';
    case 'mcpToolCall': return 'tool';
    case 'webSearch': return 'search';
    case 'reasoning': return 'think';
    default: return 'other';
  }
}

/** Maps an ACP `ToolKind` to a normalized activity kind. */
export function acpActivityKind(toolKind) {
  switch (toolKind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move': return 'file';
    case 'search': return 'search';
    case 'execute': return 'command';
    case 'think': return 'think';
    case 'fetch': return 'fetch';
    default: return 'other';
  }
}

/** A human-readable label for a Codex item, preferring its command line when present. */
export function codexActivityTitle(item) {
  return item.command ? (typeof item.command === 'string' ? item.command : JSON.stringify(item.command)) : (item.path || item.type);
}
