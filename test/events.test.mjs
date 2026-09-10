// Unit tests for src/events.mjs (PART 3: events as first-class). These exercise EventLog and
// watchEvents() in isolation, against a minimal fake EventEmitter-based "runtime", so they do not need
// a real subprocess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EventLog, watchEvents } from '../src/events.mjs';

function fakeRuntime(bufferSize) {
  const runtime = new EventEmitter();
  runtime.eventLog = new EventLog(bufferSize);
  runtime.replaying = new Set();
  runtime.publish = (conversationId, type, data, { replay } = {}) => {
    const envelope = runtime.eventLog.publish(conversationId, type, data, { replay: replay ?? runtime.replaying.has(conversationId) });
    runtime.emit('event', envelope);
    runtime.emit(type, data);
    return envelope;
  };
  return runtime;
}

test('EventLog.publish() assigns a monotonic seq per conversationId, independent of other conversations', () => {
  const log = new EventLog(10);
  const a1 = log.publish('conv_a', 'activity', { n: 1 });
  const a2 = log.publish('conv_a', 'activity', { n: 2 });
  const b1 = log.publish('conv_b', 'activity', { n: 1 });
  assert.equal(a1.seq, 1);
  assert.equal(a2.seq, 2);
  assert.equal(b1.seq, 1); // independent sequence per conversation
});

test('EventLog envelopes are JSON-safe with no live object references', () => {
  const log = new EventLog(10);
  const live = { fn: () => {}, sym: Symbol('x'), nested: { ok: true } };
  const envelope = log.publish('conv_a', 'activity', live);
  assert.equal(envelope.data.fn, undefined);
  assert.equal(envelope.data.sym, undefined);
  assert.deepEqual(envelope.data.nested, { ok: true });
  // Mutating the original object must not affect the buffered envelope (no live reference retained).
  live.nested.ok = false;
  assert.equal(envelope.data.nested.ok, true);
});

test('EventLog.since() returns only events after the given seq, with missed=0 when nothing was dropped', () => {
  const log = new EventLog(10);
  log.publish('conv_a', 'activity', { n: 1 });
  log.publish('conv_a', 'activity', { n: 2 });
  log.publish('conv_a', 'activity', { n: 3 });
  const { events, missed } = log.since('conv_a', 1);
  assert.equal(missed, 0);
  assert.deepEqual(events.map(e => e.data.n), [2, 3]);
});

test('EventLog bounds its buffer and reports a nonzero missed count once history has been evicted', () => {
  const log = new EventLog(3);
  for (let n = 1; n <= 5; n += 1) log.publish('conv_a', 'activity', { n });
  // Buffer size 3 means only seq 3,4,5 remain; a consumer that last saw seq 1 missed seq 2 (1 event).
  const { events, missed } = log.since('conv_a', 1);
  assert.equal(missed, 1);
  assert.deepEqual(events.map(e => e.data.n), [3, 4, 5]);
});

test('EventLog.clear() drops both the buffer and the sequence counter for a conversation', () => {
  const log = new EventLog(10);
  log.publish('conv_a', 'activity', { n: 1 });
  log.clear('conv_a');
  const fresh = log.publish('conv_a', 'activity', { n: 2 });
  assert.equal(fresh.seq, 1); // sequence restarted, proving the counter itself was cleared
  assert.deepEqual(log.since('conv_a', 0).events.map(e => e.data.n), [2]);
});

test('watchEvents() replays buffered backlog first, then yields live events, in order', async () => {
  const runtime = fakeRuntime(10);
  runtime.publish('conv_a', 'activity', { n: 1 });
  runtime.publish('conv_a', 'activity', { n: 2 });
  const stream = watchEvents(runtime, 'conv_a');
  const seen = [];
  const consumer = (async () => {
    for await (const envelope of stream) {
      seen.push(envelope.data.n);
      if (seen.length === 3) break;
    }
  })();
  // Give the backlog a tick to be consumed before publishing a live event.
  await new Promise(resolve => setTimeout(resolve, 10));
  runtime.publish('conv_a', 'activity', { n: 3 });
  await consumer;
  assert.deepEqual(seen, [1, 2, 3]);
});

test('watchEvents() ignores events for other conversationIds', async () => {
  const runtime = fakeRuntime(10);
  const stream = watchEvents(runtime, 'conv_a');
  const seen = [];
  const consumer = (async () => {
    for await (const envelope of stream) {
      seen.push(envelope);
      break;
    }
  })();
  runtime.publish('conv_b', 'activity', { n: 'wrong-conversation' });
  runtime.publish('conv_a', 'activity', { n: 'right-conversation' });
  await consumer;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.n, 'right-conversation');
});

test('watchEvents() yields an explicit gap envelope when the requested seq has fallen out of the buffer', async () => {
  const runtime = fakeRuntime(2); // tiny buffer to force eviction
  for (let n = 1; n <= 5; n += 1) runtime.publish('conv_a', 'activity', { n });
  const stream = watchEvents(runtime, 'conv_a', { since: 1 });
  const first = (await stream.next()).value;
  assert.equal(first.type, 'gap');
  assert.equal(first.replay, true);
  assert.ok(first.data.missed > 0);
});

test('watchEvents() marks replayed history distinctly from live events via the replay flag', async () => {
  const runtime = fakeRuntime(10);
  runtime.replaying.add('conv_a');
  runtime.publish('conv_a', 'activity', { phase: 'replayed' });
  runtime.replaying.delete('conv_a');
  runtime.publish('conv_a', 'activity', { phase: 'live' });
  const { events } = runtime.eventLog.since('conv_a', 0);
  assert.equal(events[0].replay, true);
  assert.equal(events[1].replay, false);
});

test('watchEvents() terminates cleanly when the runtime emits "lost", without needing the caller to poll', async () => {
  const runtime = fakeRuntime(10);
  const stream = watchEvents(runtime, 'conv_a');
  const consumed = [];
  const consumer = (async () => {
    for await (const envelope of stream) consumed.push(envelope);
  })();
  await new Promise(resolve => setTimeout(resolve, 10));
  runtime.emit('lost');
  await consumer; // must resolve (generator must terminate) rather than hang forever
  assert.deepEqual(consumed, []);
});
