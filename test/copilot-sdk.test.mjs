import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPILOT_TOOL_MANIFEST_VERSION,
  CopilotRuntime,
  copilotToolCatalogForModel,
  normalizeCopilotToolCall,
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
    assert.equal(typeof client.createdConfig.hooks.onPreToolUse, 'function');
    assert.equal(typeof client.createdConfig.onPermissionRequest, 'function');
    assert.deepEqual(client.createdConfig.toolSearch, { enabled: false });
    assert.deepEqual(client.createdConfig.mcpServers, {});
    assert.deepEqual(client.createdConfig.includedBuiltinSkills, []);
    assert.deepEqual(client.sessions.get(result.sessionId).permissionCalls, [
      ['configure', {
        approveAllToolPermissionRequests: false,
        approveAllReadPermissionRequests: false,
        rules: { approved: [], denied: [] },
        paths: {
          unrestricted: true,
          additionalDirectories: [],
          includeTempDirectory: true,
          workspacePath: 'C:\\work',
        },
        urls: { unrestricted: true, initialAllowed: [] },
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

test('SDK pre-tool policy defaults to unrestricted allow and ignores request listeners', async () => {
  const { client, runtime } = makeRuntime({ availableTools: ['builtin:view'] });
  runtime.on('request', () => assert.fail('pre-tool policy must not prompt by default'));
  try {
    await runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(client.permissionResult, { permissionDecision: 'allow' });
  } finally { await runtime.close(); }
});

test('SDK pre-tool policy can approve or deny only the current call', async () => {
  const policy = makeRuntime({ availableTools: ['builtin:view'], permissionPolicy: () => 'allow_once' });
  try {
    await policy.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(policy.client.permissionResult, { permissionDecision: 'allow' });
  } finally { await policy.runtime.close(); }
  const denied = makeRuntime({ availableTools: ['builtin:view'], permissionPolicy: () => 'reject_once' });
  try {
    await denied.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    const refusal = JSON.parse(denied.client.permissionResult.permissionDecisionReason);
    assert.equal(denied.client.permissionResult.permissionDecision, 'deny');
    assert.equal(refusal.code, 'tool_policy_denied');
    assert.equal(refusal.operation_id, 'engine.tool.filesystem.read');
  } finally { await denied.runtime.close(); }
});

test('SDK pre-tool policy receives complete canonical facts and returns its structured refusal', async () => {
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
    assert.deepEqual(received.facts.arguments, { path: 'C:\\work\\file.txt' });
    assert.deepEqual(JSON.parse(client.permissionResult.permissionDecisionReason), {
      code: 'tool_policy_denied',
      tool_call_id: received.id,
      operation_id: 'engine.tool.filesystem.read',
      rule_id: 'workspace-read-denied',
      reason: 'Reading this path is not allowed.',
    });
  } finally { await runtime.close(); }
});

test('SDK pre-tool policy errors and timeouts fail closed instead of throwing', async () => {
  const thrown = makeRuntime({
    availableTools: ['builtin:view'],
    permissionPolicy: () => { throw new Error('policy broke'); },
  });
  try {
    await thrown.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.equal(thrown.client.permissionResult.permissionDecision, 'deny');
    assert.match(JSON.parse(thrown.client.permissionResult.permissionDecisionReason).reason, /policy broke/);
  } finally { await thrown.runtime.close(); }

  const timedOut = makeRuntime({
    availableTools: ['builtin:view'],
    toolPolicyTimeoutMs: 5,
    permissionPolicy: () => new Promise(() => {}),
  });
  try {
    await timedOut.runtime.run('worker', { prompt: '[permission]', schema: SCHEMA }, 'C:\\work');
    assert.equal(timedOut.client.permissionResult.permissionDecision, 'deny');
    assert.match(JSON.parse(timedOut.client.permissionResult.permissionDecisionReason).reason, /timeout/);
  } finally { await timedOut.runtime.close(); }
});

test('SDK onPermissionRequest remains a fail-closed backstop', async () => {
  const { client, runtime } = makeRuntime({ availableTools: ['builtin:view'] });
  try {
    await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work');
    const result = await client.createdConfig.onPermissionRequest({ toolCallId: 'unexpected-1' });
    assert.equal(result.kind, 'reject');
    assert.match(JSON.parse(result.feedback).reason, /outside Floe's pre-tool policy gate/);
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

test('SDK tool selection is exact and model-aware without vendor agent tools', () => {
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
  assert.deepEqual(copilotToolCatalogForModel('claude-sonnet-5'), [
    'create', 'edit', 'glob', 'grep', 'list_powershell', 'powershell',
    'read_powershell', 'stop_powershell', 'view', 'web_fetch',
  ]);
  assert.deepEqual(copilotToolCatalogForModel('gpt-5.1-codex'), [
    'apply_patch', 'glob', 'list_powershell', 'powershell', 'read_powershell',
    'rg', 'stop_powershell', 'view', 'web_fetch',
  ]);
  const defaultWrite = resolveCopilotToolSelection({
    model: 'claude-sonnet-5',
    availableTools: ['builtin:create', 'builtin:edit', 'builtin:apply_patch'],
  });
  assert.deepEqual(defaultWrite.filters, ['builtin:create', 'builtin:edit']);
  const codexWrite = resolveCopilotToolSelection({
    model: 'gpt-5.1-codex',
    availableTools: ['builtin:create', 'builtin:edit', 'builtin:apply_patch'],
  });
  assert.deepEqual(codexWrite.filters, ['builtin:apply_patch']);
  assert.equal(copilotToolCatalogForModel().includes('task'), false);
  assert.equal(copilotToolCatalogForModel().includes('skill'), false);
  assert.throws(() => new CopilotRuntime({ defaultPermissionDecision: 'reject_once' }), /allow_once/);
});

test('SDK pre-tool normalization preserves full shell and write facts', () => {
  const selection = resolveCopilotToolSelection({
    availableTools: ['builtin:powershell', 'builtin:create', 'builtin:edit', 'builtin:web_fetch'],
  });
  const created = normalizeCopilotToolCall({
    toolName: 'create',
    toolArgs: { path: 'C:\\work\\file.txt', file_text: 'complete content' },
  }, { sessionId: 'session-1' }, selection, 'call-create');
  assert.equal(created.operationId, 'engine.tool.filesystem.write');
  assert.deepEqual(created.facts.paths, ['C:\\work\\file.txt']);
  assert.equal(created.facts.fileText, 'complete content');
  assert.deepEqual(created.facts.arguments, { path: 'C:\\work\\file.txt', file_text: 'complete content' });
  assert.equal(created.manifestVersion, COPILOT_TOOL_MANIFEST_VERSION);

  const edited = normalizeCopilotToolCall({
    toolName: 'edit',
    toolArgs: { path: 'C:\\work\\file.txt', old_str: 'before', new_str: 'after' },
  }, { sessionId: 'session-1' }, selection, 'call-edit');
  assert.equal(edited.facts.oldText, 'before');
  assert.equal(edited.facts.newText, 'after');

  const shell = normalizeCopilotToolCall({
    toolName: 'powershell',
    toolArgs: { command: 'npm test', description: 'run tests' },
  }, { sessionId: 'session-1' }, selection, 'call-shell');
  assert.equal(shell.operationId, 'engine.tool.process.execute');
  assert.equal(shell.facts.fullCommandText, 'npm test');
  assert.deepEqual(shell.facts.arguments, { command: 'npm test', description: 'run tests' });
  assert.equal(typeof shell.facts.argumentDigest, 'string');
});

test('SDK apply_patch normalization parses every path and fails closed on malformed input', () => {
  const selection = resolveCopilotToolSelection({
    model: 'gpt-5.1-codex',
    availableTools: ['builtin:apply_patch'],
  });
  const patch = [
    '*** Begin Patch',
    '*** Add File: new.txt',
    '+new content',
    '*** Update File: old.txt',
    '*** Move to: moved.txt',
    '@@',
    '-before',
    '+after',
    '*** Delete File: gone.txt',
    '*** End Patch',
  ].join('\n');
  const normalized = normalizeCopilotToolCall({
    toolName: 'apply_patch',
    toolArgs: patch,
  }, { sessionId: 'session-1' }, selection, 'call-patch');
  assert.deepEqual(normalized.facts.paths, ['new.txt', 'old.txt', 'moved.txt', 'gone.txt']);
  assert.equal(normalized.facts.patch, patch);
  assert.deepEqual(normalized.facts.changes.map(change => change.kind), ['add', 'update', 'delete']);
  assert.throws(
    () => normalizeCopilotToolCall(
      { toolName: 'apply_patch', toolArgs: '*** Begin Patch\nbad\n*** End Patch' },
      { sessionId: 'session-1' },
      selection,
      'call-bad',
    ),
    error => error.code === 'copilot_tool_arguments_invalid',
  );
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
    assert.equal(client.permissionResult.permissionDecision, 'deny');
    assert.equal(JSON.parse(client.permissionResult.permissionDecisionReason).code, 'tool_policy_denied');
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
    assert.equal(client.optionsUpdates.length, 1);
  } finally { await runtime.close(); }
});

test('SDK model changes replace the exact tool catalog and its hook together', async () => {
  const { client, runtime } = makeRuntime({
    model: 'claude-sonnet-5',
    availableTools: ['builtin:create', 'builtin:edit', 'builtin:apply_patch', 'builtin:grep', 'builtin:rg'],
  });
  try {
    const result = await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(client.sessions.get(result.sessionId).config.availableTools, [
      'builtin:create', 'builtin:edit', 'builtin:grep',
    ]);
    const oldHook = client.sessions.get(result.sessionId).config.hooks.onPreToolUse;
    await runtime.setModel(result.sessionId, 'gpt-5.1-codex');
    assert.deepEqual(client.sessions.get(result.sessionId).config.availableTools, [
      'builtin:apply_patch', 'builtin:rg',
    ]);
    assert.notEqual(client.sessions.get(result.sessionId).config.hooks.onPreToolUse, oldHook);
  } finally { await runtime.close(); }
});

test('SDK rejects invalid tool-policy timeouts before creating a session', () => {
  assert.throws(
    () => makeRuntime({ toolPolicyTimeoutMs: 0 }),
    /positive finite number/,
  );
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
