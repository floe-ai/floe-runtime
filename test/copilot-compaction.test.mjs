import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotRuntime } from '../src/adapters/copilot.mjs';
import { FakeCopilotClient } from './fake-copilot-sdk.mjs';

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['ok', 'summary'],
};

function makeRuntime(options = {}, client = new FakeCopilotClient()) {
  return {
    client,
    runtime: new CopilotRuntime({
      client,
      clientOptions: { baseDirectory: 'C:\\floe-session' },
      expectedAccount: { label: 'octocat', host: 'https://github.com' },
      timeoutMs: 1000,
      quiesceTimeoutMs: 25,
      ...options,
    }),
  };
}

const compactionsOf = runtime => {
  const events = [];
  runtime.on('compaction', event => events.push(event));
  return events;
};

test('compact() runs a focused manual compaction and returns a normalized result', async () => {
  const { client, runtime } = makeRuntime();
  const events = compactionsOf(runtime);
  try {
    const first = await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
    const result = await runtime.compact(first.sessionId, 'keep design decisions and rejected options');
    assert.deepEqual(client.compactCalls, [{ trigger: 'manual', customInstructions: 'keep design decisions and rejected options' }]);
    assert.deepEqual(result, {
      runtime: 'copilot', sessionId: first.sessionId, success: true, tokensRemoved: 4000, messagesRemoved: 3,
      summary: '<overview>Kept the decisions.</overview>', error: null,
    });
    assert.deepEqual(events.map(event => [event.phase, event.trigger]), [['started', 'manual'], ['completed', 'manual']]);
    const completed = events[1];
    assert.equal(completed.focus, 'keep design decisions and rejected options');
    assert.equal(completed.tokensBefore, 5000);
    assert.equal(completed.tokensAfter, 1000);
    assert.equal(completed.summary, '<overview>Kept the decisions.</overview>');
    assert.equal(completed.raw.type, 'session.compaction_complete');
  } finally { await runtime.close(); }
});

test('compact() without focus sends no focus instructions', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
    await runtime.compact(first.sessionId);
    assert.deepEqual(client.compactCalls, [{ trigger: 'manual' }]);
  } finally { await runtime.close(); }
});

test('a background compaction between runs publishes a compaction event', async () => {
  const { client, runtime } = makeRuntime();
  const events = compactionsOf(runtime);
  try {
    const first = await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
    client.sessions.get(first.sessionId).backgroundCompaction();
    assert.deepEqual(events.map(event => [event.sessionId, event.phase, event.trigger, event.tokensRemoved]), [
      [first.sessionId, 'started', 'threshold', null],
      [first.sessionId, 'completed', 'threshold', 58000],
    ]);
  } finally { await runtime.close(); }
});

test('a failed compaction resolves with success false and the SDK error', async () => {
  const { client, runtime } = makeRuntime();
  const events = compactionsOf(runtime);
  try {
    const first = await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
    client.compactFailure = 'Nothing to compact.';
    const result = await runtime.compact(first.sessionId);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Nothing to compact.');
    assert.equal(events.at(-1).phase, 'failed');
    assert.equal(events.at(-1).error, 'Nothing to compact.');
  } finally { await runtime.close(); }
});

test('compact() refuses a session with an active turn', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
    const pending = runtime.run('worker', { prompt: '[cancel]' }, 'C:\\work', () => {}, {}, { sessionId: first.sessionId });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => runtime.compact(first.sessionId), { code: 'turn_busy' });
    assert.deepEqual(client.compactCalls, []);
    await runtime.interrupt(first.sessionId);
    await pending.catch(() => {});
  } finally { await runtime.close(); }
});

test('compact() refuses an unknown session', async () => {
  const { runtime } = makeRuntime();
  try {
    await assert.rejects(() => runtime.compact('missing-session'), { code: 'session_unavailable' });
  } finally { await runtime.close(); }
});

test('after a restart, compact() resumes the old session and run() continues it', async () => {
  const client = new FakeCopilotClient();
  const first = makeRuntime({}, client).runtime;
  const { sessionId } = await first.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
  await first.close();

  const { runtime } = makeRuntime({}, client);
  const events = compactionsOf(runtime);
  try {
    const result = await runtime.compact(sessionId, 'keep decisions');
    assert.equal(result.success, true);
    assert.equal(client.sessions.get(sessionId).config.workingDirectory, 'C:\\work');
    assert.deepEqual(events.map(event => event.phase), ['started', 'completed']);
    let meta;
    await runtime.run('worker', { prompt: 'continue', schema: SCHEMA }, 'C:\\work', (_id, info) => { meta = info; }, {}, { sessionId });
    assert.equal(meta.session.action, 'reused');
  } finally { await runtime.close(); }
});

test('infiniteSessions reaches the SDK from runtime options, and a run setting overrides it', async () => {
  const { client, runtime } = makeRuntime({ infiniteSessions: { enabled: false } });
  try {
    await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(client.createdConfig.infiniteSessions, { enabled: false });
    await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work', () => {}, {
      infiniteSessions: { backgroundCompactionThreshold: 0.3 },
    });
    assert.deepEqual(client.createdConfig.infiniteSessions, { backgroundCompactionThreshold: 0.3 });
  } finally { await runtime.close(); }
});

test('infiniteSessions is left to the SDK default when not set', async () => {
  const { client, runtime } = makeRuntime();
  try {
    await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work');
    assert.equal(Object.hasOwn(client.createdConfig, 'infiniteSessions'), false);
  } finally { await runtime.close(); }
});

test('infiniteSessions is fixed for a live session', async () => {
  const { runtime } = makeRuntime();
  try {
    const opened = { infiniteSessions: { enabled: false } };
    const first = await runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work', () => {}, opened);
    const continuation = { sessionId: first.sessionId };
    await runtime.run('worker', { prompt: 'again', schema: SCHEMA }, 'C:\\work', () => {}, {}, continuation);
    await runtime.run('worker', { prompt: 'same', schema: SCHEMA }, 'C:\\work', () => {}, opened, continuation);
    await assert.rejects(
      () => runtime.run('worker', { prompt: 'change', schema: SCHEMA }, 'C:\\work', () => {}, { infiniteSessions: { enabled: true } }, continuation),
      { code: 'copilot_compaction_settings_locked' },
    );
  } finally { await runtime.close(); }
});

test('an invalid infiniteSessions setting is refused', async () => {
  for (const infiniteSessions of [true, { enabled: 'no' }, { backgroundCompactionThreshold: 1.5 }, { auto: true }]) {
    assert.throws(() => makeRuntime({ infiniteSessions }), TypeError);
  }
  const { runtime } = makeRuntime();
  try {
    await assert.rejects(
      () => runtime.run('worker', { prompt: 'plant', schema: SCHEMA }, 'C:\\work', () => {}, { infiniteSessions: { bufferExhaustionThreshold: 0 } }),
      TypeError,
    );
  } finally { await runtime.close(); }
});
