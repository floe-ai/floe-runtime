import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotRuntime } from '../src/adapters/copilot.mjs';
import { FakeCopilotClient } from './fake-copilot-sdk.mjs';

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['ok', 'summary'],
};

function makeRuntime(options = {}) {
  const client = new FakeCopilotClient();
  return { client, runtime: new CopilotRuntime({ client, timeoutMs: 100, quiesceTimeoutMs: 25, ...options }) };
}

test('SDK runtime completes a turn only at session.idle and supports multiple model turns', async () => {
  const { runtime } = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: '[multi]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(result.report, { ok: true, summary: 'done' });
    assert.equal(result.turnId, 'model-turn-1');
  } finally { await runtime.close(); }
});

test('SDK runtime streams text and normalizes direct tool activity', async () => {
  const { runtime } = makeRuntime();
  const streams = [];
  const activity = [];
  runtime.on('stream', event => streams.push(event));
  runtime.on('activity', event => activity.push(event));
  try {
    await runtime.run('worker', { prompt: '[stream][tool]', schema: SCHEMA }, 'C:\\work');
    assert.equal(streams.map(event => event.delta).join(''), '{"ok":true,"summary":"streamed"}');
    assert.deepEqual(activity.map(event => event.status), ['started', 'completed']);
  } finally { await runtime.close(); }
});

test('SDK runtime awaits asynchronous setup before sending and preserves setup cancellation', async () => {
  const { client, runtime } = makeRuntime();
  let releaseSetup;
  let setupEntered;
  const setupReady = new Promise(resolve => { setupEntered = resolve; });
  const setupBarrier = new Promise(resolve => { releaseSetup = resolve; });
  const cancelled = Object.assign(new Error('cancelled before send'), { code: 'interrupted', status: 409 });
  try {
    const pending = runtime.run('worker', { prompt: 'must not send', schema: SCHEMA }, 'C:\\work', async () => {
      setupEntered();
      await setupBarrier;
      throw cancelled;
    });
    await setupReady;
    assert.deepEqual(client.sendOrder, []);
    releaseSetup();
    await assert.rejects(pending, error => error.code === 'interrupted');
    assert.deepEqual(client.sendOrder, []);
  } finally { await runtime.close(); }
});

test('SDK runtime registers system messages, direct tools, and narrow tool allow-lists at session creation', async () => {
  const tool = { name: 'lookup', description: 'Look up a value', parameters: { type: 'object' }, handler: () => 'ok' };
  const { client, runtime } = makeRuntime({
    systemMessage: { mode: 'append', content: 'Floe guardrails' },
    tools: [tool],
    availableTools: ['custom:lookup'],
    excludedTools: ['builtin:shell'],
  });
  try {
    await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work');
    assert.equal(client.createdConfig.systemMessage.content, 'Floe guardrails');
    assert.equal(client.createdConfig.tools[0].name, 'lookup');
    assert.deepEqual(client.createdConfig.availableTools, ['custom:lookup']);
    assert.deepEqual(client.createdConfig.excludedTools, ['builtin:shell']);
  } finally { await runtime.close(); }
});

test('SDK runtime keeps session errors, missing final messages, and incomplete output distinct', async () => {
  for (const [prompt, code] of [['[error]', 'session_error'], ['[missing]', 'missing_final_message'], ['[incomplete]', 'report_incomplete']]) {
    const { runtime } = makeRuntime();
    try {
      await assert.rejects(runtime.run('worker', { prompt, schema: SCHEMA }, 'C:\\work'), error => error.code === code);
    } finally { await runtime.close(); }
  }
});

test('SDK model.call_failure rejects even if a final assistant message arrives', async () => {
  const { runtime } = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[model-call-failure]', schema: SCHEMA }, 'C:\\work'),
      error => error.code === 'model_call_failure' && error.message.includes('provider failed'),
    );
  } finally { await runtime.close(); }
});

test('SDK runtime maps supported non-text blocks and rejects unsupported blocks before send', async () => {
  const { client, runtime } = makeRuntime();
  try {
    await runtime.run('worker', {
      blocks: [
        { type: 'text', text: 'inspect this image' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', displayName: 'diagram.png' },
      ],
      schema: SCHEMA,
    }, 'C:\\work');
    assert.deepEqual(client.lastSendOptions, {
      prompt: 'inspect this image',
      attachments: [{ type: 'blob', data: 'aGVsbG8=', mimeType: 'image/png', displayName: 'diagram.png' }],
    });
    await assert.rejects(
      runtime.run('worker', { blocks: [{ type: 'embedded_context', value: 'lost' }], schema: SCHEMA }, 'C:\\work'),
      error => error.code === 'unsupported_prompt_block',
    );
  } finally { await runtime.close(); }
});

test('SDK runtime capabilities do not advertise unsupported control methods', () => {
  const { runtime } = makeRuntime();
  const capabilities = runtime.capabilities();
  assert.equal(capabilities.setMode, false);
  assert.equal(capabilities.setPermissions, false);
  assert.equal(capabilities.setGoal, false);
  assert.equal(capabilities.compact, false);
  assert.equal(capabilities.usage, false);
  assert.equal(capabilities.availableCommands, false);
  assert.equal(capabilities.fleetMode, false);
  assert.equal(capabilities.scheduleRecurring, false);
  assert.equal(capabilities.scheduleOnce, false);
  assert.throws(() => runtime.availableCommands('session-1'), error => error.code === 'capability_unsupported');
});

test('SDK permission listener has precedence and responds through runtime.respond', async () => {
  const { client, runtime } = makeRuntime({ permissionPolicy: () => 'reject_once', defaultPermissionDecision: 'reject_once' });
  runtime.on('request', message => runtime.respond(message.id, { decision: 'allow_once' }));
  try {
    await runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(client.permissionResult, { kind: 'approve-once' });
  } finally { await runtime.close(); }
});

test('SDK permission policy and configured default decision are applied when no listener exists', async () => {
  const policy = makeRuntime({ permissionPolicy: () => 'allow_always' });
  try {
    await policy.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(policy.client.permissionResult, { kind: 'approve-for-session' });
  } finally { await policy.runtime.close(); }
  const fallback = makeRuntime({ defaultPermissionDecision: 'allow_once' });
  try {
    await fallback.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(fallback.client.permissionResult, { kind: 'approve-once' });
  } finally { await fallback.runtime.close(); }
});

test('SDK permission listener times out to deny even when the configured default allows', async () => {
  const { client, runtime } = makeRuntime({ unhandledRequestTimeoutMs: 5, defaultPermissionDecision: 'allow_once' });
  runtime.on('request', () => {});
  try {
    await runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(client.permissionResult, { kind: 'reject', feedback: 'Floe denied this operation.' });
  } finally { await runtime.close(); }
});

test('SDK cancellation waits for abort acknowledgement and then idle', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const pending = runtime.run('worker', { prompt: '[cancel]', schema: SCHEMA }, 'C:\\work', sessionId => {
      setTimeout(() => runtime.interrupt(sessionId), 0);
    });
    await assert.rejects(pending, error => error.code === 'interrupted');
    assert.deepEqual(client.sendOrder.slice(0, 2), ['send', 'abort']);
  } finally { await runtime.close(); }
});

test('SDK cancellation fails with quiescence_unknown when abort never reaches idle', async () => {
  const { client, runtime } = makeRuntime();
  client.abortWithoutIdle = true;
  try {
    const pending = runtime.run('worker', { prompt: '[cancel]', schema: SCHEMA }, 'C:\\work', sessionId => {
      setTimeout(() => runtime.interrupt(sessionId), 0);
    });
    await assert.rejects(pending, error => error.code === 'quiescence_unknown');
  } finally { await runtime.close(); }
});

test('SDK runtime preserves model listing and selection', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const models = await runtime.models();
    assert.equal(models[0].modelId, 'gpt-5-mini');
    const result = await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work', () => {}, { model: 'fixture-model' });
    await runtime.setModel(result.sessionId, 'gpt-5-mini');
    assert.equal(client.sessions.get(result.sessionId).config.model, 'gpt-5-mini');
  } finally { await runtime.close(); }
});

test('SDK resume ignores legacy goal options instead of invoking unsupported goal handling', async () => {
  const { runtime } = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work');
    runtime.setGoal = () => { throw new Error('Copilot setGoal must remain unsupported'); };
    const resumed = await runtime.resume(first.sessionId, 'C:\\work', { goal: 'must not be applied' });
    assert.equal(resumed, first.sessionId);
  } finally { await runtime.close(); }
});
