import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CodexRuntime } from '../src/adapters/codex.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs');
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'] };

function makeRuntime(options = {}) {
  return new CodexRuntime({ executable: process.execPath, args: [fixture], timeoutMs: 5000, ...options });
}

test('start() performs the handshake and reports ready', async () => {
  const runtime = makeRuntime();
  try {
    const info = await runtime.start();
    assert.equal(info.userAgent, 'fake-codex/1.0');
    assert.equal(runtime.ready, true);
  } finally {
    await runtime.close();
  }
});

test('run() validates a well-formed structured report', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
    assert.ok(result.threadId);
  } finally {
    await runtime.close();
  }
});

test('run() rejects when the agent message is not valid JSON', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[bad-json] do something', schema: SCHEMA }, '/tmp/work'),
      error => error.code === 'invalid_report',
    );
  } finally {
    await runtime.close();
  }
});

test('run() rejects when the report is missing a required field', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[missing] do something', schema: SCHEMA }, '/tmp/work'),
      error => error.code === 'invalid_report',
    );
  } finally {
    await runtime.close();
  }
});

test('interrupt() during a delayed turn rejects the run() promise as interrupted', async () => {
  const runtime = makeRuntime();
  try {
    const pending = runtime.run('worker', { prompt: '[delay] do something', schema: SCHEMA }, '/tmp/work', threadId => {
      setTimeout(() => runtime.interrupt(threadId), 20);
    });
    await assert.rejects(pending, error => error.code === 'interrupted');
  } finally {
    await runtime.close();
  }
});

test('quiesce() then retire() releases a completed session', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(result.threadId);
    const outcome = await runtime.retire(result.threadId);
    assert.equal(outcome.status, 'unsubscribed');
  } finally {
    await runtime.close();
  }
});

test('a matching continuation reuses the previous session', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work', () => {}, {}, { scope: 'issue-1' });
    await runtime.quiesce(first.threadId);
    const actions = [];
    const second = await runtime.run('worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/work', (threadId, meta) => { actions.push(meta.session.action); }, {}, { threadId: first.threadId, scope: 'issue-1' });
    assert.equal(actions[0], 'reused');
    assert.equal(second.threadId, first.threadId);
  } finally {
    await runtime.close();
  }
});

// -- G1: normalized activity events --------------------------------------

test('run() emits normalized started/completed activity events for a command item', async () => {
  const runtime = makeRuntime();
  const activity = [];
  runtime.on('activity', event => activity.push(event));
  try {
    const result = await runtime.run('worker', { prompt: '[command] do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(activity.length, 2);
    assert.equal(activity[0].status, 'started');
    assert.equal(activity[1].status, 'completed');
    for (const event of activity) {
      assert.equal(event.runtime, 'codex');
      assert.equal(event.kind, 'command');
      assert.equal(event.id, 'cmd_' + result.turnId);
      assert.equal(event.sessionId, result.threadId);
      assert.equal(event.command, 'echo fixture');
    }
    assert.equal(activity[0].endedAt, null);
    assert.ok(activity[1].endedAt >= activity[1].startedAt);
  } finally {
    await runtime.close();
  }
});

test('run() does not emit an activity event for the final agentMessage item', async () => {
  const runtime = makeRuntime();
  const activity = [];
  runtime.on('activity', event => activity.push(event));
  try {
    await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(activity.length, 0);
  } finally {
    await runtime.close();
  }
});

// -- G2: permission policy -------------------------------------------------

test('with no permissionPolicy and no request listener, an approval request is denied by default', async () => {
  const runtime = makeRuntime();
  const decisions = [];
  runtime.on('notification', message => { if (message.method === 'fixture/approvalDecision') decisions.push(message.params.result); });
  try {
    const result = await runtime.run('worker', { prompt: '[approval] do something', schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'decline');
  } finally {
    await runtime.close();
  }
});

test('a configured permissionPolicy answers an approval request', async () => {
  const seen = [];
  const runtime = makeRuntime({
    permissionPolicy: request => { seen.push(request); return 'allow_once'; },
  });
  const decisions = [];
  runtime.on('notification', message => { if (message.method === 'fixture/approvalDecision') decisions.push(message.params.result); });
  try {
    await runtime.run('worker', { prompt: '[approval] do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].runtime, 'codex');
    assert.equal(seen[0].kind, 'command');
    assert.ok(seen[0].options.some(option => option.decision === 'allow_once'));
    assert.equal(decisions[0].decision, 'accept');
  } finally {
    await runtime.close();
  }
});

test('an explicit request listener takes precedence over both policy and default', async () => {
  const runtime = makeRuntime({ permissionPolicy: () => 'reject_once' });
  const decisions = [];
  runtime.on('notification', message => { if (message.method === 'fixture/approvalDecision') decisions.push(message.params.result); });
  runtime.on('request', message => runtime.respond(message.id, { decision: 'accept' }));
  try {
    await runtime.run('worker', { prompt: '[approval] do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(decisions[0].decision, 'accept', 'the manual listener answer must win, not the policy');
  } finally {
    await runtime.close();
  }
});

test('an unrecognized request type is auto-declined by the unhandled-request timeout safety net', async () => {
  const runtime = makeRuntime({ unhandledRequestTimeoutMs: 50 });
  const settled = [];
  runtime.on('notification', message => { if (message.method === 'fixture/unknownRequestSettled') settled.push(message.params.error); });
  try {
    const result = await runtime.run('worker', { prompt: '[unknown-request] do something', schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
    assert.equal(settled.length, 1);
    assert.ok(settled[0], 'the fixture should have received a JSON-RPC error, not a result');
    assert.equal(settled[0].code, -32000);
  } finally {
    await runtime.close();
  }
});

// -- capability declaration --------------------------------------------------

test('capabilities() declares the Codex parity surface', () => {
  const runtime = makeRuntime();
  const caps = runtime.capabilities();
  assert.equal(caps.setModel, true);
  assert.equal(caps.setMode, false);
  assert.equal(caps.availableCommands, false);
  assert.equal(caps.steer, true);
});

// -- P12: streaming events ----------------------------------------------------

test('run() emits normalized stream events for live text/reasoning/command-output deltas', async () => {
  const runtime = makeRuntime();
  const streamed = [];
  runtime.on('stream', event => streamed.push(event));
  try {
    await runtime.run('worker', { prompt: '[stream] do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(streamed.length, 3);
    assert.deepEqual(streamed.map(e => e.kind), ['text', 'reasoning', 'commandOutput']);
    assert.deepEqual(streamed.map(e => e.delta), ['partial ', 'thinking ', 'output ']);
    for (const event of streamed) assert.equal(event.runtime, 'codex');
  } finally {
    await runtime.close();
  }
});

// -- P13: rich prompt input ---------------------------------------------------

test('run() passes input.blocks straight through to turn/start when supplied', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { blocks: [{ type: 'text', text: JSON.stringify({ ok: true, summary: 'Fixture output' }) }], schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
  } finally {
    await runtime.close();
  }
});

// -- P1/B1, P4, P5, P6, P7, P8, P9, P10, P11, P3, P14 parity surface ---------

test('setModel() overrides the model on this thread\'s next turn/start call', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(first.threadId);
    runtime.setModel(first.threadId, 'better-model');
    const metas = [];
    await runtime.run('worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/work', (threadId, meta) => metas.push(meta), {}, { threadId: first.threadId, scope: 'issue-1' });
    assert.equal(metas[0].model, 'better-model');
  } finally {
    await runtime.close();
  }
});

test('setPermissions() overrides the permission level applied on this thread\'s next turn/start call', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(first.threadId);
    runtime.setPermissions(first.threadId, 'allow-all');
    const metas = [];
    await runtime.run('worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/work', (threadId, meta) => metas.push(meta), {}, { threadId: first.threadId, scope: 'issue-1' });
    assert.equal(metas[0].approvalPolicy, 'never');
    assert.equal(metas[0].sandbox, 'danger-full-access');
  } finally {
    await runtime.close();
  }
});

test('setPermissions() rejects an unknown level', () => {
  const runtime = makeRuntime();
  assert.throws(() => runtime.setPermissions('thread_x', 'nonsense'), { code: 'invalid_permission_level' });
});

test('setMode() is declared unsupported on Codex', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(() => runtime.setMode('thread_x', 'plan'), { code: 'capability_unsupported' });
  } finally {
    await runtime.close();
  }
});

test('availableCommands() is declared unsupported on Codex', () => {
  const runtime = makeRuntime();
  assert.throws(() => runtime.availableCommands('thread_x'), { code: 'capability_unsupported' });
});

test('setGoal() sets and clears a thread goal, and rejects an unsupported maxCredits option', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.setGoal(first.threadId, 'Ship the feature');
    await runtime.setGoal(first.threadId, null);
    await assert.rejects(() => runtime.setGoal(first.threadId, 'Ship it', { maxCredits: 10 }), { code: 'capability_unsupported' });
  } finally {
    await runtime.close();
  }
});

test('compact() requests thread/compact/start', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const result = await runtime.compact(first.threadId, 'focus on tests');
    assert.equal(result.started, true);
  } finally {
    await runtime.close();
  }
});

test('usage() combines account/usage/read and account/rateLimits/read', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.usage();
    assert.equal(result.backend, 'codex');
    assert.equal(result.raw.usage.requests, 5);
    assert.equal(result.raw.rateLimits.limit, 100);
  } finally {
    await runtime.close();
  }
});

test('steer() injects guidance into a running turn via turn/steer', async () => {
  const runtime = makeRuntime();
  try {
    const started = new Promise(resolve => {
      runtime.on('notification', function handler(message) {
        if (message.method === 'turn/started') { runtime.off('notification', handler); resolve(message.params.threadId); }
      });
    });
    const runPromise = runtime.run('worker', { prompt: '[delay] do something', schema: SCHEMA }, '/tmp/work');
    const threadId = await started;
    const result = await runtime.steer(threadId, 'focus on the tests');
    assert.equal(result.accepted, true);
    await runPromise;
  } finally {
    await runtime.close();
  }
});

test('steer() rejects when there is no active turn', async () => {
  const runtime = makeRuntime();
  await assert.rejects(() => runtime.steer('thread_none', 'go'), { code: 'no_active_turn' });
});

test('fork() requests thread/fork', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const forked = await runtime.fork(first.threadId);
    assert.ok(forked.thread.id);
    assert.notEqual(forked.thread.id, first.threadId);
  } finally {
    await runtime.close();
  }
});

test('listSessions() requests thread/list', async () => {
  const runtime = makeRuntime();
  try {
    await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const list = await runtime.listSessions();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
  } finally {
    await runtime.close();
  }
});

test('resume() requests thread/resume and registers the thread for reuse/quiesce/retire', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
    const resumedId = await runtime.resume(first.threadId);
    assert.equal(resumedId, first.threadId);
    await runtime.quiesce(resumedId);
    await runtime.retire(resumedId);
  } finally {
    await runtime.close();
  }
});

// -- Architecture batch PART 1: ban polling ---------------------------------------------------------

test('quiesce() settles a background turn from a pushed notification without ever re-reading thread/read on a timer', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: '[background-turn] do something', schema: SCHEMA }, '/tmp/work');
    const before = await runtime.request('debug/counters', {});
    await runtime.quiesce(first.threadId);
    const after = await runtime.request('debug/counters', {});
    // The fixture's stray in-progress turn is discovered on the first thread/read, interrupted, and its
    // turn/completed notification resolves the wait - this must take at most the initial read plus one
    // confirmatory re-read, never a retry loop re-reading on an interval.
    assert.ok(after.threadReadCalls - before.threadReadCalls <= 2, `expected <=2 thread/read calls during quiesce(), got ${after.threadReadCalls - before.threadReadCalls}`);
  } finally {
    await runtime.close();
  }
});

test('quiesce() awaits the running turn\'s settlement promise directly, not a membership-polling loop', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: '[delay] do something', schema: SCHEMA }, '/tmp/work');
    // quiesce() while the [delay] turn is still active must interrupt it and resolve promptly (well under
    // the fixture's 200ms completion delay and the 10s timeout guard), proving it is event-driven.
    const startedAt = Date.now();
    await runtime.quiesce(first.threadId);
    assert.ok(Date.now() - startedAt < 1000, 'quiesce() took too long - it may be polling on a fixed interval instead of awaiting a push event');
  } finally {
    await runtime.close();
  }
});

// -- Architecture batch PART 2: conversation lifetime and resumability ------------------------------

test('run() creates a persistent (non-ephemeral) thread by default', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const state = await runtime.request('thread/read', { threadId: first.threadId, includeTurns: false });
    assert.equal(state.thread.ephemeral, false);
  } finally {
    await runtime.close();
  }
});

test('run() honors settings.ephemeral:true as an explicit opt-out of persistence', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work', () => {}, { ephemeral: true });
    const state = await runtime.request('thread/read', { threadId: first.threadId, includeTurns: false });
    assert.equal(state.thread.ephemeral, true);
  } finally {
    await runtime.close();
  }
});

test('a completed turn never ends or retires the conversation - only an explicit retire() does', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    // The turn is done, but the session must still be tracked and usable until the caller retires it.
    assert.ok(runtime.sessions.has(first.threadId));
    const listed = await runtime.listSessions();
    assert.ok(listed.some(t => t.id === first.threadId));
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
  } finally {
    await runtime.close();
  }
});

test('sweepOrphans() releases only threads older than maxAgeMs that this runtime is not tracking', async () => {
  const runtime = makeRuntime();
  try {
    const tracked = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(tracked.threadId);
    await runtime.retire(tracked.threadId); // no longer tracked locally, simulating an orphan candidate
    await runtime.request('debug/age-thread', { threadId: tracked.threadId, ageMs: 30 * 24 * 60 * 60 * 1000 }); // 30 days old
    const other = await runtime.run('worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/other');
    const result = await runtime.sweepOrphans({ maxAgeMs: 21 * 24 * 60 * 60 * 1000 });
    assert.ok(result.swept.includes(tracked.threadId));
    assert.ok(!result.swept.includes(other.threadId)); // still tracked locally, and not old enough
    await runtime.quiesce(other.threadId);
    await runtime.retire(other.threadId);
  } finally {
    await runtime.close();
  }
});

test('resume() marks its restored snapshot as replay, followed by a replayComplete event', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
    const seen = [];
    runtime.on('event', envelope => { if (envelope.conversationId === first.threadId) seen.push(envelope); });
    await runtime.resume(first.threadId);
    const replayEvent = seen.find(e => e.type === 'replay');
    const completeEvent = seen.find(e => e.type === 'replayComplete');
    assert.ok(replayEvent, 'expected a replay envelope');
    assert.equal(replayEvent.replay, true);
    assert.ok(completeEvent, 'expected a replayComplete envelope');
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
  } finally {
    await runtime.close();
  }
});

// This is the exact bug the resume-across-process-death smoke test caught live: calling resume()
// DIRECTLY left the restored thread's reuse key permanently null (never adopted), so a following run()
// could never recognize it as reusable and silently started a brand-new thread, discarding the
// just-restored conversation.
test('a thread explicitly resume()d by the caller is still reused by the next run() call (requires an explicit scope)', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work', () => {}, {}, { scope: 'issue-1' });
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
    await runtime.resume(first.threadId); // explicit resume(), not via run()'s own reuse path
    const actions = [];
    const second = await runtime.run(
      'worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/work',
      (threadId, meta) => { actions.push(meta.session.action); }, {}, { threadId: first.threadId, scope: 'issue-1' },
    );
    assert.equal(second.threadId, first.threadId);
    assert.equal(actions[0], 'reused');
    await runtime.quiesce(second.threadId);
    await runtime.retire(second.threadId);
  } finally {
    await runtime.close();
  }
});

// -- F9/F10/F11: real-server behaviour discovered by live probing -------------------------------------

test('F9: a turn failing with codexErrorInfo usageLimitExceeded raises a distinct usage_limit_exceeded fault', async () => {
  const runtime = makeRuntime();
  try {
    const events = [];
    runtime.on('event', envelope => { if (envelope.type === 'budgetCeilingReached') events.push(envelope); });
    await assert.rejects(
      runtime.run('worker', { prompt: '[usage-limit] do something', schema: SCHEMA }, '/tmp/work'),
      error => { assert.equal(error.code, 'usage_limit_exceeded'); assert.match(error.message, /spend cap/i); return true; },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].data.source, 'backend');
  } finally {
    await runtime.close();
  }
});

test('F10: previously-unhandled Codex notifications are surfaced as usage/diagnostic/activity/notice events, not dropped', async () => {
  const runtime = makeRuntime();
  try {
    let threadId;
    const started = new Promise(resolve => {
      runtime.on('event', envelope => { if (envelope.type === 'turn' && envelope.data.phase === 'started') { threadId = envelope.conversationId; resolve(); } });
    });
    const runPromise = runtime.run('worker', { prompt: '[hang] do something', schema: SCHEMA }, '/tmp/work');
    await started;
    const events = [];
    const diagnostics = [];
    runtime.on('event', envelope => events.push(envelope));
    runtime.on('diagnostic', text => diagnostics.push(text));
    await runtime.request('debug/emit-f10', { threadId });
    await new Promise(resolve => setImmediate(resolve)); // let the notification queue flush - not a poll, just yielding once
    assert.ok(events.some(e => e.type === 'usage' && e.data.rateLimits), 'account/rateLimits/updated should fold into usage');
    assert.ok(diagnostics.some(text => /server error/i.test(text)), 'error notification should reach diagnostics');
    assert.ok(events.some(e => e.type === 'serverError'), 'error notification should also be structurally published');
    assert.ok(events.some(e => e.type === 'activity' && e.data.kind === 'hook' && e.data.status === 'started'));
    assert.ok(events.some(e => e.type === 'activity' && e.data.kind === 'hook' && e.data.status === 'completed'));
    assert.ok(diagnostics.some(text => /MCP server startup status/i.test(text)));
    assert.ok(events.some(e => e.type === 'notice' && e.data.kind === 'mcpServerStartupStatus'));
    assert.ok(events.some(e => e.type === 'notice' && e.data.kind === 'settingsChanged'));
    await runtime.interrupt(threadId);
    await assert.rejects(runPromise);
    await runtime.quiesce(threadId);
    await runtime.retire(threadId);
  } finally {
    await runtime.close();
  }
});

test('F11: resume() re-applies a thread\'s last known goal after Codex silently clears it', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.setGoal(first.threadId, 'Ship the feature.');
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
    const events = [];
    runtime.on('event', envelope => { if (envelope.conversationId === first.threadId) events.push(envelope); });
    const resumedId = await runtime.resume(first.threadId);
    assert.ok(events.some(e => e.type === 'goalReapplied'), 'expected the goal to be silently re-applied after resume');
    assert.equal(runtime.goals.get(resumedId), 'Ship the feature.');
    await runtime.quiesce(resumedId);
    await runtime.retire(resumedId);
  } finally {
    await runtime.close();
  }
});

test('F11: resume() accepts an explicit goal override, for a fresh runtime instance with no in-memory history', async () => {
  const first = makeRuntime();
  let threadId;
  try {
    const started = await first.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    threadId = started.threadId;
    await first.setGoal(threadId, 'Original objective.');
    await first.quiesce(threadId);
    await first.retire(threadId);
  } finally {
    await first.close();
  }
  // A brand-new instance has no in-memory goal history - this simulates Fleet's crash-recovery path,
  // which spawns a fresh CodexRuntime and must pass the caller's own persisted goal explicitly.
  const second = makeRuntime();
  try {
    const events = [];
    second.on('event', envelope => { if (envelope.conversationId === threadId) events.push(envelope); });
    const resumedId = await second.resume(threadId, { goal: 'Recovered objective.' });
    assert.ok(events.some(e => e.type === 'goalReapplied' && e.data.objective === 'Recovered objective.'));
    await second.quiesce(resumedId);
    await second.retire(resumedId);
  } finally {
    await second.close();
  }
});


// -- Architecture batch PART 3: events as first-class -------------------------------------------------

test('run() publishes turn lifecycle events (started, then completed) for a normal turn', async () => {
  const runtime = makeRuntime();
  try {
    const phases = [];
    runtime.on('event', envelope => { if (envelope.type === 'turn') phases.push(envelope.data.phase); });
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(phases, ['started', 'completed']);
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
  } finally {
    await runtime.close();
  }
});

test('interrupt() during a turn publishes an "interrupted" turn lifecycle event', async () => {
  const runtime = makeRuntime();
  try {
    const phases = [];
    runtime.on('event', envelope => { if (envelope.type === 'turn') phases.push(envelope.data.phase); });
    const pending = runtime.run('worker', { prompt: '[delay] do something', schema: SCHEMA }, '/tmp/work', threadId => {
      setTimeout(() => runtime.interrupt(threadId), 20);
    });
    await assert.rejects(pending, error => error.code === 'interrupted');
    assert.deepEqual(phases, ['started', 'interrupted']);
  } finally {
    await runtime.close();
  }
});

test('runtime.events(threadId) is an async-iterable stream that a consumer can `for await` over', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: '[stream] do something', schema: SCHEMA }, '/tmp/work');
    const seen = [];
    for await (const envelope of runtime.events(first.threadId)) {
      seen.push(envelope.type);
      if (envelope.type === 'turn' && envelope.data.phase === 'completed') break;
    }
    assert.ok(seen.includes('stream'));
    assert.ok(seen.includes('turn'));
    await runtime.quiesce(first.threadId);
    await runtime.retire(first.threadId);
  } finally {
    await runtime.close();
  }
});

