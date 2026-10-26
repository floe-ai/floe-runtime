// Backend-neutral compaction shapes shared by the Copilot and Codex adapters (README: "Compaction").

/** One `compaction` event. Fields a backend does not report are null. */
export function compactionEvent(runtime, sessionId, fields) {
  return {
    runtime,
    sessionId,
    phase: fields.phase,
    trigger: fields.trigger ?? null,
    tokensBefore: fields.tokensBefore ?? null,
    tokensAfter: fields.tokensAfter ?? null,
    tokensRemoved: fields.tokensRemoved ?? null,
    messagesRemoved: fields.messagesRemoved ?? null,
    focus: fields.focus ?? null,
    summary: fields.summary ?? null,
    error: fields.error ?? null,
    raw: fields.raw ?? null,
  };
}

/** The value `compact()` resolves with. Fields a backend does not report are null. */
export function compactResult(runtime, sessionId, fields) {
  return {
    runtime,
    sessionId,
    success: fields.success ?? null,
    tokensRemoved: fields.tokensRemoved ?? null,
    messagesRemoved: fields.messagesRemoved ?? null,
    summary: fields.summary ?? null,
    error: fields.error ?? null,
  };
}

/** Maps a Copilot SDK `session.compaction_*` event to a `compaction` event, or null for other events. */
export function copilotCompactionEvent(sessionId, event) {
  const data = event?.data || {};
  if (event?.type === 'session.compaction_start') {
    return compactionEvent('copilot', sessionId, {
      phase: 'started', trigger: data.trigger, tokensBefore: data.currentTokens, raw: event,
    });
  }
  if (event?.type !== 'session.compaction_complete') return null;
  return compactionEvent('copilot', sessionId, {
    phase: data.success === false ? 'failed' : 'completed',
    trigger: data.trigger,
    tokensBefore: data.preCompactionTokens,
    tokensAfter: data.postCompactionTokens,
    tokensRemoved: data.tokensRemoved,
    messagesRemoved: data.messagesRemoved,
    focus: data.customInstructions,
    summary: data.summaryContent,
    error: data.error,
    raw: event,
  });
}

const THRESHOLDS = ['backgroundCompactionThreshold', 'bufferExhaustionThreshold'];

/** Validates the SDK `infiniteSessions` setting (automatic compaction). Undefined means the SDK default. */
export function normalizeInfiniteSessions(value, label = 'infiniteSessions') {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Copilot ${label} must be an object.`);
  }
  const allowed = new Set(['enabled', ...THRESHOLDS]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Copilot ${label}.${key} is not a known setting.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new TypeError(`Copilot ${label}.enabled must be a boolean.`);
  }
  for (const key of THRESHOLDS) {
    const threshold = value[key];
    if (threshold !== undefined && !(Number.isFinite(threshold) && threshold > 0 && threshold <= 1)) {
      throw new TypeError(`Copilot ${label}.${key} must be a number above 0 and at most 1.`);
    }
  }
  return { ...value };
}
