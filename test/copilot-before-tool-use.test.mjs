import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotRuntime } from '../src/adapters/copilot.mjs';
import { FakeCopilotClient } from './fake-copilot-sdk.mjs';

const VIEW = { toolName: 'view', toolArgs: { path: 'C:\\work\\file.txt' } };
const LOOKUP = { toolName: 'lookup', toolArgs: { id: '1' } };

async function hookFor(options = {}) {
  const client = new FakeCopilotClient();
  const diagnostics = [];
  const runtime = new CopilotRuntime({
    client,
    clientOptions: { baseDirectory: 'C:\\floe-session' },
    expectedAccount: { label: 'octocat', host: 'https://github.com' },
    timeoutMs: 100,
    quiesceTimeoutMs: 25,
    tools: [{ name: 'lookup', handler: () => 'found' }],
    availableTools: ['builtin:view', 'custom:lookup'],
    ...options,
  });
  runtime.on('diagnostic', text => diagnostics.push(text));
  await runtime.run('worker', { prompt: 'hello' }, 'C:\\work');
  const hook = client.createdConfig.hooks.onPreToolUse;
  const call = (input, sessionId = 'session-1') => hook(
    { sessionId, timestamp: new Date(), workingDirectory: 'C:\\work', ...input },
    { sessionId },
  );
  return { runtime, diagnostics, call };
}

function refusalOf(result) {
  assert.equal(result.permissionDecision, 'deny');
  return JSON.parse(result.permissionDecisionReason);
}

test('beforeToolUse sees built-in and custom calls and allows when it returns nothing', async () => {
  const policyIds = [];
  const seen = [];
  const { runtime, call } = await hookFor({
    permissionPolicy(request) { policyIds.push(request.id); return 'allow_once'; },
    beforeToolUse(received) { seen.push(received); },
  });
  try {
    assert.deepEqual(await call(VIEW), { permissionDecision: 'allow' });
    assert.deepEqual(await call(LOOKUP), { permissionDecision: 'allow' });
    assert.equal(policyIds.length, 1, 'custom tools still skip the permission policy');
    assert.deepEqual(seen.map(({ id, ...rest }) => rest), [
      { toolName: 'view', source: 'builtin', args: VIEW.toolArgs, sessionId: 'session-1', cwd: 'C:\\work' },
      { toolName: 'lookup', source: 'custom', args: LOOKUP.toolArgs, sessionId: 'session-1', cwd: 'C:\\work' },
    ]);
    assert.equal(seen[0].id, policyIds[0], 'built-in call id matches the id the policy saw');
    assert.equal(typeof seen[1].id, 'string');
    assert.notEqual(seen[1].id, seen[0].id);
  } finally { await runtime.close(); }
});

test('beforeToolUse is never called after a policy denial', async () => {
  let called = false;
  const { runtime, call } = await hookFor({
    permissionPolicy: () => 'reject_once',
    beforeToolUse() { called = true; return { decision: 'allow' }; },
  });
  try {
    assert.equal(refusalOf(await call(VIEW)).code, 'tool_policy_denied');
    assert.equal(called, false);
  } finally { await runtime.close(); }
});

test('beforeToolUse can block a built-in or custom call with a reason', async () => {
  const { runtime, diagnostics, call } = await hookFor({
    beforeToolUse: received => ({ decision: 'block', reason: `No ${received.toolName} today.` }),
  });
  try {
    const builtin = refusalOf(await call(VIEW));
    assert.equal(builtin.code, 'tool_policy_denied');
    assert.equal(builtin.operation_id, 'engine.tool.filesystem.read');
    assert.equal(builtin.reason, 'No view today.');
    const custom = refusalOf(await call(LOOKUP));
    assert.equal(custom.reason, 'No lookup today.');
    assert.equal(typeof custom.tool_call_id, 'string');
    assert.equal(diagnostics.filter(text => /beforeToolUse blocked tool/.test(text)).length, 2);
  } finally { await runtime.close(); }
});

test('beforeToolUse can change the input of built-in and custom calls', async () => {
  const policyArgs = [];
  const { runtime, diagnostics, call } = await hookFor({
    permissionPolicy(request) { policyArgs.push(request.facts.arguments); return 'allow_once'; },
    beforeToolUse(received) {
      return received.source === 'builtin'
        ? { decision: 'change', args: { path: 'C:\\work\\other.txt' } }
        : { decision: 'change', args: { id: '2' } };
    },
  });
  try {
    assert.deepEqual(await call(VIEW), { permissionDecision: 'allow', modifiedArgs: { path: 'C:\\work\\other.txt' } });
    assert.deepEqual(await call(LOOKUP), { permissionDecision: 'allow', modifiedArgs: { id: '2' } });
    assert.deepEqual(policyArgs, [VIEW.toolArgs, { path: 'C:\\work\\other.txt' }], 'changed built-in input is re-decided');
    assert.equal(diagnostics.filter(text => /beforeToolUse changed the input/.test(text)).length, 2);
  } finally { await runtime.close(); }
});

test('a changed built-in call cannot get past the permission policy', async () => {
  const { runtime, diagnostics, call } = await hookFor({
    permissionPolicy: request => (request.facts.paths[0].endsWith('secret.txt') ? 'reject_once' : 'allow_once'),
    beforeToolUse: () => ({ decision: 'change', args: { path: 'C:\\work\\secret.txt' } }),
  });
  try {
    assert.equal(refusalOf(await call(VIEW)).code, 'tool_policy_denied');
    assert.ok(diagnostics.some(text => /was denied by the permission policy/.test(text)));
  } finally { await runtime.close(); }
});

test('beforeToolUse failures block the call and emit a diagnostic', async () => {
  const cases = [
    { name: 'throws', beforeToolUse: () => { throw new Error('callback broke'); }, reason: /callback broke/ },
    { name: 'times out', beforeToolUse: () => new Promise(() => {}), reason: /timeout/ },
    { name: 'unknown decision', beforeToolUse: () => ({ decision: 'allow_always' }), reason: /unsupported decision/ },
    { name: 'change without args', beforeToolUse: () => ({ decision: 'change' }), reason: /without providing args/ },
    { name: 'invalid built-in args', beforeToolUse: () => ({ decision: 'change', args: {} }), reason: /did not provide 'path'/ },
  ];
  for (const scenario of cases) {
    const { runtime, diagnostics, call } = await hookFor({
      toolPolicyTimeoutMs: 5,
      beforeToolUse: scenario.beforeToolUse,
    });
    try {
      assert.match(refusalOf(await call(VIEW)).reason, scenario.reason, scenario.name);
      assert.ok(diagnostics.some(text => /beforeToolUse failed closed/.test(text)), scenario.name);
    } finally { await runtime.close(); }
  }
});

test('beforeToolUse must be a function', () => {
  assert.throws(() => new CopilotRuntime({
    client: new FakeCopilotClient(),
    clientOptions: { baseDirectory: 'C:\\floe-session' },
    expectedAccount: { label: 'octocat' },
    beforeToolUse: 'nope',
  }), /beforeToolUse must be a function/);
});
