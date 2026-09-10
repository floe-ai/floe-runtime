// Backend-neutral event envelope + bounded per-conversation replay buffer.
//
// Every event floe-runtime emits (activity, stream, turn lifecycle, replay
// markers) is wrapped in a small JSON-safe envelope before it reaches a
// consumer, so events can be persisted, logged, and replayed by an app that
// closes and reopens mid-conversation - never a live object reference. This
// is NOT a transport/sockets layer (there is no daemon, no shared pool -
// every app owns its own floe-runtime instance); it exists purely so the
// same event stream a live app observes can be recorded and reconstructed.
//
// A monotonic `seq` per conversationId (a threadId/sessionId) lets a
// resuming consumer ask "what have I missed since seq N" via
// EventLog#since(); if that seq has already fallen out of the bounded
// buffer, `missed` reports exactly how many events were dropped instead of
// silently losing them (see Runtime#events()'s 'gap' envelope).

const DEFAULT_BUFFER_SIZE = 500;

/** Strips any non-JSON-safe value (functions, symbols, live object refs) via a round-trip. */
function toSerializable(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

export class EventLog {
  constructor(bufferSize = DEFAULT_BUFFER_SIZE) {
    this.bufferSize = bufferSize;
    this.seqs = new Map(); // conversationId -> last seq issued
    this.buffers = new Map(); // conversationId -> array of envelopes (bounded, oldest first)
  }

  /** Wraps `data` into a JSON-safe envelope with the next monotonic seq for `conversationId`, and buffers it. */
  publish(conversationId, type, data, { replay = false } = {}) {
    const seq = (this.seqs.get(conversationId) || 0) + 1;
    this.seqs.set(conversationId, seq);
    const envelope = { seq, conversationId, type, replay, at: Date.now(), data: toSerializable(data) };
    let buffer = this.buffers.get(conversationId);
    if (!buffer) { buffer = []; this.buffers.set(conversationId, buffer); }
    buffer.push(envelope);
    if (buffer.length > this.bufferSize) buffer.shift();
    return envelope;
  }

  /**
   * Returns every buffered envelope for `conversationId` with seq > `afterSeq`, plus `missed`: the count of
   * envelopes that fell out of the bounded buffer before a consumer could see them (0 if none were lost).
   */
  since(conversationId, afterSeq = 0) {
    const buffer = this.buffers.get(conversationId) || [];
    const oldestSeq = buffer.length ? buffer[0].seq : (this.seqs.get(conversationId) || 0) + 1;
    const missed = afterSeq > 0 && afterSeq < oldestSeq - 1 ? oldestSeq - 1 - afterSeq : 0;
    return { events: buffer.filter(envelope => envelope.seq > afterSeq), missed };
  }

  clear(conversationId) {
    this.buffers.delete(conversationId);
    this.seqs.delete(conversationId);
  }
}

/**
 * An async-iterable live feed of envelopes for one conversationId, backed entirely by push events
 * (Runtime#publish -> the runtime's 'event' emission) - never a timer poll. Replays any buffered history
 * first (yielding a synthetic 'gap' envelope first if `since` has already fallen out of the bounded
 * buffer), then yields live envelopes as they are published, until the caller stops iterating
 * (`break`/`return`) or the runtime disconnects.
 *
 * Ergonomics: a consumer never has to correlate ids by hand - `for await (const envelope of
 * runtime.events(sessionId)) { ... }` sees exactly this conversation's activity/stream/turn events, in
 * order, already deduplicated between replayed history and live activity via `envelope.replay`.
 */
export function watchEvents(runtime, conversationId, { since = 0 } = {}) {
  const queue = [];
  let waiter = null;
  let closed = false;
  const push = envelope => {
    if (envelope.conversationId !== conversationId) return;
    queue.push(envelope);
    if (waiter) { const resolve = waiter; waiter = null; resolve(); }
  };
  const onLost = () => { closed = true; if (waiter) { const resolve = waiter; waiter = null; resolve(); } };
  runtime.on('event', push);
  runtime.once('lost', onLost);

  const { events: backlog, missed } = runtime.eventLog.since(conversationId, since);

  async function* generator() {
    try {
      if (missed > 0) yield { seq: since, conversationId, type: 'gap', replay: true, at: Date.now(), data: { missed } };
      for (const envelope of backlog) yield envelope;
      while (!closed) {
        if (queue.length === 0) await new Promise(resolve => { waiter = resolve; });
        while (queue.length > 0) yield queue.shift();
      }
    } finally {
      runtime.off('event', push);
      runtime.off('lost', onLost);
    }
  }
  return generator();
}
