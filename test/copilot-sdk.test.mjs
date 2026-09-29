import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPILOT_TOOL_MANIFEST_VERSION,
  CopilotRuntime,
  normalizeCopilotPermissionRequest,
  resolveCopilotToolSelection,
} from '../src/adapters/copilot.mjs';
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

test('SDK runtime aggregates every model call and tool call in a turn', async () => {
  const { runtime } = makeRuntime();
  const usageEvents = [];
  runtime.on('usage', event => usageEvents.push(event));
  try {
    const result = await runtime.run('worker', { prompt: '[multi-usage]', schema: SCHEMA }, 'C:\\work');
    assert.equal(result.usage.inputTokens, 450);
    assert.equal(result.usage.outputTokens, 100);
    assert.equal(result.usage.cacheReadTokens, 100);
    assert.equal(result.usage.cacheWriteTokens, 12);
    assert.equal(result.usage.numModelCalls, 3);
    assert.equal(result.usage.numToolCalls, 2);
    assert.deepEqual(result.usage.modelCalls.map(call => ({
      apiCallId: call.apiCallId,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
    })), [
      { apiCallId: 'call-1', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5 },
      { apiCallId: 'call-2', inputTokens: 150, outputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: undefined },
      { apiCallId: 'call-3', inputTokens: 200, outputTokens: 50, cacheReadTokens: undefined, cacheWriteTokens: 7 },
    ]);
    assert.equal(usageEvents.length, 3);
    assert.equal(usageEvents.at(-1).numModelCalls, 3);
    assert.equal(usageEvents.at(-1).numToolCalls, 2);
    assert.equal(usageEvents.at(-1).inputTokens, 450);
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
    availableTools: ['custom:lookup', 'builtin:view'],
  });
  try {
    const result = await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work');
    assert.equal(client.createdConfig.systemMessage.content, 'Floe guardrails');
    assert.equal(client.createdConfig.tools[0].name, 'lookup');
    assert.deepEqual(client.createdConfig.availableTools, ['custom:lookup', 'builtin:view']);
    assert.deepEqual(client.createdConfig.excludedTools, []);
    assert.equal(client.createdConfig.enableFileHooks, false);
    assert.equal(client.createdConfig.enableConfigDiscovery, false);
    assert.deepEqual(client.createdConfig.toolSearch, { enabled: false });
    assert.deepEqual(client.createdConfig.mcpServers, {});
    assert.deepEqual(client.createdConfig.includedBuiltinSkills, []);
    assert.deepEqual(client.sessions.get(result.sessionId).permissionCalls, [
      ['configure', {
        approveAllToolPermissionRequests: false,
        approveAllReadPermissionRequests: false,
        rules: { approved: [], denied: [] },
        paths: {
          unrestricted: false,
          additionalDirectories: [],
          includeTempDirectory: false,
          workspacePath: 'C:\\work',
        },
        urls: { unrestricted: false, initialAllowed: [] },
      }],
      ['setApproveAll', { enabled: false }],
      ['setMode', { mode: 'manual' }],
      ['resetSessionApprovals', { includeLocation: false }],
    ]);
  } finally { await runtime.close(); }
});

test('SDK runtime keeps session errors and incomplete output distinct', async () => {
  for (const [prompt, code] of [['[error]', 'session_error'], ['[incomplete]', 'report_incomplete']]) {
    const { runtime } = makeRuntime();
    try {
      await assert.rejects(runtime.run('worker', { prompt, schema: SCHEMA }, 'C:\\work'), error => error.code === code);
    } finally { await runtime.close(); }
  }
});

test('SDK runtime treats a normal turn with no final message as success with empty text', async () => {
  // Real adapter path against a simulated SDK session that reaches session.idle (aborted: false)
  // without emitting any assistant message. This is a normal Actor behaviour (e.g. asking a
  // question then ending the turn silently) and must succeed, not throw missing_final_message.
  const { runtime } = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: '[missing]' }, 'C:\\work');
    assert.equal(result.text, '');
    assert.equal(result.report, '');
    assert.equal(result.stopReason, 'end_turn');
  } finally { await runtime.close(); }
});

test('SDK runtime still rejects when the SDK reports a genuine session error on an otherwise silent turn', async () => {
  // Guard: a real SDK error must remain a failure even though there is no final message.
  const { runtime } = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[error][missing]' }, 'C:\\work'),
      error => error.code === 'session_error',
    );
  } finally { await runtime.close(); }
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
  const { client, runtime } = makeRuntime({
    availableTools: ['builtin:view'],
    permissionPolicy: () => 'reject_once',
  });
  runtime.on('request', message => runtime.respond(message.id, { decision: 'allow_once' }));
  try {
    await runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(client.permissionResult, { kind: 'approve-once' });
  } finally { await runtime.close(); }
});

test('SDK permission policy can approve only the current call and defaults to denial', async () => {
  const policy = makeRuntime({ availableTools: ['builtin:view'], permissionPolicy: () => 'allow_once' });
  try {
    await policy.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(policy.client.permissionResult, { kind: 'approve-once' });
  } finally { await policy.runtime.close(); }
  const fallback = makeRuntime({ availableTools: ['builtin:view'] });
  try {
    await fallback.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    const refusal = JSON.parse(fallback.client.permissionResult.feedback);
    assert.equal(fallback.client.permissionResult.kind, 'reject');
    assert.equal(refusal.code, 'tool_policy_denied');
    assert.equal(refusal.operation_id, 'engine.tool.filesystem.read');
  } finally { await fallback.runtime.close(); }
});

test('SDK permission policy receives canonical facts and returns its structured refusal', async () => {
  let received;
  const { client, runtime } = makeRuntime({
    availableTools: ['builtin:view'],
    permissionPolicy(request) {
      received = request;
      return {
        decision: 'reject_once',
        refusal: { rule_id: 'workspace-read-denied', reason: 'Reading this path is not allowed.' },
      };
    },
  });
  try {
    await runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.equal(received.operationId, 'engine.tool.filesystem.read');
    assert.deepEqual(received.nativeToolCandidates, ['view']);
    assert.deepEqual(received.facts.paths, ['C:\\work\\file.txt']);
    assert.equal(typeof received.facts.argumentDigest, 'string');
    assert.deepEqual(JSON.parse(client.permissionResult.feedback), {
      code: 'tool_policy_denied',
      tool_call_id: 'permission-1',
      operation_id: 'engine.tool.filesystem.read',
      rule_id: 'workspace-read-denied',
      reason: 'Reading this path is not allowed.',
    });
  } finally { await runtime.close(); }
});

test('SDK permission listener times out to a structured denial', async () => {
  const { client, runtime } = makeRuntime({ availableTools: ['builtin:view'], unhandledRequestTimeoutMs: 5 });
  runtime.on('request', () => {});
  try {
    await runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.equal(client.permissionResult.kind, 'reject');
    assert.equal(JSON.parse(client.permissionResult.feedback).code, 'tool_policy_denied');
  } finally { await runtime.close(); }
});

test('SDK runtime forces empty client mode', async () => {
  let options;
  const client = new FakeCopilotClient();
  const runtime = new CopilotRuntime({
    clientFactory: received => { options = received; return client; },
    clientOptions: { mode: 'copilot-cli' },
    timeoutMs: 100,
  });
  try {
    await runtime.start();
    assert.equal(options.mode, 'empty');
  } finally { await runtime.close(); }
});

test('SDK tool selection rejects wildcards, MCP, unknown built-ins, and persistent defaults', () => {
  assert.throws(
    () => resolveCopilotToolSelection({ availableTools: ['builtin:*'] }),
    error => error.code === 'copilot_tool_selection_invalid',
  );
  assert.throws(
    () => resolveCopilotToolSelection({ availableTools: ['mcp:request'] }),
    error => error.code === 'copilot_tool_selection_invalid',
  );
  assert.throws(
    () => resolveCopilotToolSelection({ availableTools: ['builtin:sql'] }),
    error => error.code === 'copilot_tool_selection_invalid',
  );
  assert.throws(
    () => resolveCopilotToolSelection({ availableTools: ['builtin:create'] }),
    error => error.code === 'copilot_tool_selection_invalid',
  );
  assert.throws(
    () => resolveCopilotToolSelection({ availableTools: ['builtin:edit'] }),
    error => error.code === 'copilot_tool_selection_invalid',
  );
  assert.throws(
    () => resolveCopilotToolSelection({ availableTools: ['builtin:apply_patch'] }),
    error => error.code === 'copilot_tool_selection_invalid',
  );
  assert.throws(() => new CopilotRuntime({ defaultPermissionDecision: 'allow_once' }), /reject_once/);
});

test('SDK permission normalization produces canonical policy facts without file contents', () => {
  const selection = resolveCopilotToolSelection({
    availableTools: ['builtin:powershell', 'builtin:web_fetch'],
  });
  const unsupportedWrite = normalizeCopilotPermissionRequest({
    kind: 'write',
    toolCallId: 'write-1',
    fileName: 'C:\\work\\file.txt',
    diff: '+secret',
    newFileContents: 'secret',
    requestSandboxBypass: true,
  }, { sessionId: 'session-1' }, selection);
  assert.equal(unsupportedWrite.operationId, null);
  assert.deepEqual(unsupportedWrite.nativeToolCandidates, []);
  assert.deepEqual(unsupportedWrite.facts.paths, ['C:\\work\\file.txt']);
  assert.equal(unsupportedWrite.facts.requestSandboxBypass, true);
  assert.equal(typeof unsupportedWrite.facts.contentDigest, 'string');
  assert.equal(JSON.stringify(unsupportedWrite.facts).includes('secret'), false);
  assert.equal(unsupportedWrite.manifestVersion, COPILOT_TOOL_MANIFEST_VERSION);

  const shell = normalizeCopilotPermissionRequest({
    kind: 'shell',
    fullCommandText: 'npm test',
    commands: [{ identifier: 'npm', readOnly: false }],
    commandSegments: [{ identifier: 'npm', fullCommandText: 'npm test' }],
    possiblePaths: ['C:\\work'],
    possibleUrls: [{ url: 'https://registry.npmjs.org' }],
    hasWriteFileRedirection: false,
  }, { sessionId: 'session-1' }, selection);
  assert.equal(shell.operationId, 'engine.tool.process.execute');
  assert.deepEqual(shell.facts.urls, ['https://registry.npmjs.org']);
});

test('SDK catalog drift fails before a prompt is sent', async () => {
  const { client, runtime } = makeRuntime({ availableTools: ['builtin:view'] });
  client.catalogOverride = ['view', 'sql'];
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: 'must not send' }, 'C:\\work'),
      error => error.code === 'copilot_tool_catalog_drift',
    );
    assert.deepEqual(client.sendOrder, ['disconnect']);
  } finally { await runtime.close(); }
});

test('SDK rejects persistent policy decisions instead of widening later calls', async () => {
  const { client, runtime } = makeRuntime({
    availableTools: ['builtin:view'],
    permissionPolicy: () => 'allow_always',
  });
  try {
    await runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.equal(client.permissionResult.kind, 'reject');
    assert.equal(JSON.parse(client.permissionResult.feedback).code, 'tool_policy_denied');
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
