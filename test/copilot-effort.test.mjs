import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotRuntime } from '../src/adapters/copilot.mjs';
import { FakeCopilotClient } from './fake-copilot-sdk.mjs';

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['ok', 'summary'],
};
// [effort-usage] makes the fake report the effort Copilot used, as live assistant.usage events do.
const PROMPT = { prompt: '[effort-usage] hello', schema: SCHEMA };

function makeRuntime(options = {}) {
  const client = new FakeCopilotClient();
  const runtime = new CopilotRuntime({
    client,
    clientOptions: { baseDirectory: 'C:\\floe-session' },
    expectedAccount: { label: 'octocat', host: 'https://github.com' },
    timeoutMs: 100,
    quiesceTimeoutMs: 25,
    ...options,
  });
  return { client, runtime };
}

async function withRuntime(options, body) {
  const { client, runtime } = makeRuntime(options);
  try { await body({ client, runtime }); } finally { await runtime.close(); }
}

test('effort is sent to Copilot on create and reported in onStart and the result', () => withRuntime({}, async ({ client, runtime }) => {
  const metas = [];
  const result = await runtime.run('worker', PROMPT, 'C:\\work', (id, meta) => metas.push(meta), { model: 'gpt-5-mini', effort: 'low' });
  assert.equal(client.createdConfig.reasoningEffort, 'low');
  assert.equal(metas[0].effort, 'low');
  assert.equal(result.effort, 'low');
}));

test('omitting effort sends nothing and reports the effort Copilot chose', () => withRuntime({}, async ({ client, runtime }) => {
  const metas = [];
  const result = await runtime.run('worker', PROMPT, 'C:\\work', (id, meta) => metas.push(meta), { model: 'gpt-5-mini' });
  assert.equal(Object.hasOwn(client.createdConfig, 'reasoningEffort'), false);
  assert.equal(metas[0].effort, null);
  assert.equal(result.effort, 'medium');
  const plain = await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work', () => {}, { model: 'gpt-5-mini' });
  assert.equal(plain.effort, null);
}));

test('an effort the model cannot use is refused before a session is created', () => withRuntime({}, async ({ client, runtime }) => {
  await assert.rejects(
    runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'claude-haiku-4.5', effort: 'low' }),
    error => error.code === 'copilot_effort_unavailable' && error.status === 400
      && error.message.includes('does not support reasoning effort'),
  );
  await assert.rejects(
    runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5-mini', effort: 'max' }),
    error => error.code === 'copilot_effort_unavailable' && error.message.includes('Supported levels: low, medium, high.'),
  );
  assert.equal(client.sessions.size, 0);
}));

test('a model whose catalogue entry declares nothing about effort is left to Copilot', () => withRuntime({}, async ({ client, runtime }) => {
  await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'fixture-model', effort: 'high' });
  assert.equal(client.createdConfig.reasoningEffort, 'high');
}));

test('setModel() can change model and effort together on a live session', () => withRuntime({}, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5-mini', effort: 'low' });
  await runtime.setModel(first.sessionId, 'claude-sonnet-5', { effort: 'max' });
  assert.deepEqual(client.setModelCalls, [['claude-sonnet-5', { reasoningEffort: 'max' }]]);
  const next = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, {}, { sessionId: first.sessionId });
  assert.equal(next.sessionId, first.sessionId);
  assert.equal(next.effort, 'max');
}));

test('two-argument setModel() keeps the current effort when the new model supports it', () => withRuntime({}, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5-mini', effort: 'low' });
  await runtime.setModel(first.sessionId, 'gpt-5.4');
  assert.deepEqual(client.setModelCalls, [['gpt-5.4', undefined]]);
  const next = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, {}, { sessionId: first.sessionId });
  assert.equal(next.effort, 'low');
}));

test('setModel() refuses a model that cannot keep the current effort instead of silently resetting it', () => withRuntime({}, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'claude-sonnet-5', effort: 'max' });
  await assert.rejects(
    runtime.setModel(first.sessionId, 'gpt-5-mini'),
    error => error.code === 'copilot_effort_unavailable' && error.message.includes("current reasoning effort 'max'"),
  );
  assert.equal(client.setModelCalls.length, 0);
  assert.equal(client.sessions.get(first.sessionId).config.model, 'claude-sonnet-5');
}));

test('a switch Copilot rejects leaves the session usable and unchanged', () => withRuntime({}, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5-mini', effort: 'low' });
  client.sessions.get(first.sessionId).setModel = async () => { throw new Error('Reasoning effort is not supported'); };
  await assert.rejects(
    runtime.setModel(first.sessionId, 'gpt-5-mini', { effort: 'high' }),
    error => error.code === 'copilot_model_switch_rejected' && error.message.includes('Reasoning effort is not supported'),
  );
  const next = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, {}, { sessionId: first.sessionId });
  assert.equal(next.sessionId, first.sessionId);
  assert.equal(next.effort, 'low');
}));

test('a continued run() applies a new effort and keeps it when the next run omits it', () => withRuntime({}, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5-mini', effort: 'low' });
  const raised = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { effort: 'high' }, { sessionId: first.sessionId });
  assert.deepEqual(client.setModelCalls, [['gpt-5-mini', { reasoningEffort: 'high' }]]);
  assert.equal(raised.effort, 'high');
  const kept = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, {}, { sessionId: first.sessionId });
  assert.equal(client.setModelCalls.length, 1);
  assert.equal(kept.effort, 'high');
}));

test('a continued run() applies an explicit model but not the runtime default', () => withRuntime({ model: 'claude-sonnet-5' }, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work');
  await runtime.setModel(first.sessionId, 'gpt-5-mini');
  await runtime.run('worker', PROMPT, 'C:\\work', () => {}, {}, { sessionId: first.sessionId });
  assert.equal(client.sessions.get(first.sessionId).config.model, 'gpt-5-mini');
  await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5.4' }, { sessionId: first.sessionId });
  assert.equal(client.sessions.get(first.sessionId).config.model, 'gpt-5.4');
  assert.deepEqual(client.setModelCalls.map(([model]) => model), ['gpt-5-mini', 'gpt-5.4']);
}));

test('an effort-only change on a default-model session uses the model Copilot reports', () => withRuntime({}, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { effort: 'low' });
  await runtime.setModel(first.sessionId, undefined, { effort: 'high' });
  assert.deepEqual(client.setModelCalls, [['gpt-5-mini', { reasoningEffort: 'high' }]]);
}));

test('effort is sent when a persisted session is resumed', () => withRuntime({}, async ({ client, runtime }) => {
  const first = await runtime.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5-mini' });
  const { runtime: fresh } = makeRuntime({ client });
  try {
    const resumed = await fresh.run('worker', PROMPT, 'C:\\work', () => {}, { model: 'gpt-5-mini', effort: 'high' }, { sessionId: first.sessionId });
    assert.equal(client.sessions.get(first.sessionId).config.reasoningEffort, 'high');
    assert.equal(resumed.effort, 'high');
  } finally { await fresh.close(); }
}));
