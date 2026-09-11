import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CopilotRuntime } from '../src/adapters/copilot.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-copilot.mjs');
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'] };

function makeRuntime(options = {}) {
  return new CopilotRuntime({ executable: process.execPath, args: [fixture], timeoutMs: 5000, ...options });
}

test('start() performs the ACP handshake and reports capabilities', async () => {
  const runtime = makeRuntime();
  try {
    const info = await runtime.start();
    assert.equal(info.protocolVersion, 1);
    assert.equal(runtime.agentCapabilities.loadSession, true);
  } finally {
    await runtime.close();
  }
});

test('run() validates a well-formed structured report', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
    assert.equal(result.stopReason, 'end_turn');
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

// Completeness gating: ACP's StopReason (https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-
// reasons, confirmed in the released schema.json's StopReason $def) is the ONLY signal that tells us
// whether the agent's final message was actually finished ('end_turn') versus cut off mid-stream
// ('max_tokens', 'max_turn_requests') - extraction must never run against a message that wasn't
// confirmed complete. See #finishTurn's INCOMPLETE_STOP_REASONS map in src/adapters/copilot.mjs.
test('run() extracts a report normally on end_turn (prose + fenced JSON already covered by schema.test.mjs; this pins the stopReason itself)', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
  } finally {
    await runtime.close();
  }
});

test('run() raises a distinct report_incomplete fault on max_tokens and never attempts to parse the truncated text', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[max-tokens] do something', schema: SCHEMA }, '/tmp/work'),
      error => error.code === 'report_incomplete'
        && error.message.includes('max_tokens')
        && !/invalid_report/.test(error.code), // must be its OWN fault code, never conflated with malformed JSON
    );
  } finally {
    await runtime.close();
  }
});

test('run() raises report_incomplete on max_turn_requests too (the other ACP "incomplete" stop reason)', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[max-turn-requests] do something', schema: SCHEMA }, '/tmp/work'),
      error => error.code === 'report_incomplete' && error.message.includes('max_turn_requests'),
    );
  } finally {
    await runtime.close();
  }
});

test('run() does NOT accept a truncated-but-brace-balanced fragment under max_tokens as a report (the silent-corruption case)', async () => {
  const runtime = makeRuntime();
  try {
    // [max-tokens-balanced]'s fixture text is a COMPLETE, schema-valid JSON object - if extraction were
    // mistakenly attempted despite the incomplete stopReason, it would wrongly succeed. It must not run.
    await assert.rejects(
      runtime.run('worker', { prompt: '[max-tokens-balanced] do something', schema: SCHEMA }, '/tmp/work'),
      error => error.code === 'report_incomplete',
    );
  } finally {
    await runtime.close();
  }
});

test('run() fails closed on a stop reason outside ACP\'s known set, rather than assuming it is safe to parse', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[unknown-stop] do something', schema: SCHEMA }, '/tmp/work'),
      error => error.code === 'report_incomplete' && error.message.includes('model_handoff'),
    );
  } finally {
    await runtime.close();
  }
});

test('run() keeps only the LAST message when the agent sends two agent_message_chunk updates with different messageIds', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: '[two-messages] do something', schema: SCHEMA }, '/tmp/work');
    // The first message ("WRONG, superseded") must be fully discarded - schema.json's ContentChunk
    // messageId field: "A change in messageId indicates a new message has started."
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
    assert.ok(!result.text.includes('superseded'));
  } finally {
    await runtime.close();
  }
});

test('run() never lets an agent_thought_chunk contaminate the accumulated report text', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { prompt: '[thought] do something', schema: SCHEMA }, '/tmp/work');
    // The fixture's thought chunk carries JSON-shaped decoy text ("this is a THOUGHT, not the report") -
    // if it were mistakenly accumulated, the report would come from it instead of the real message.
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
    assert.ok(!result.text.includes('THOUGHT'));
  } finally {
    await runtime.close();
  }
});

test('interrupt() cancels an in-flight prompt turn', async () => {
  const runtime = makeRuntime();
  try {
    const pending = runtime.run('worker', { prompt: '[cancel-only] do something', schema: SCHEMA }, '/tmp/work', sessionId => {
      setTimeout(() => runtime.interrupt(sessionId), 20);
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
    await runtime.quiesce(result.sessionId);
    const outcome = await runtime.retire(result.sessionId);
    assert.equal(outcome.status, 'deleted');
  } finally {
    await runtime.close();
  }
});

test('a matching continuation reuses the previous session without a new session/new call', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work', () => {}, {}, { scope: 'issue-1' });
    await runtime.quiesce(first.sessionId);
    const actions = [];
    const second = await runtime.run('worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/work', (sessionId, meta) => { actions.push(meta.session.action); }, {}, { sessionId: first.sessionId, scope: 'issue-1' });
    assert.equal(actions[0], 'reused');
    assert.equal(second.sessionId, first.sessionId);
  } finally {
    await runtime.close();
  }
});

// -- G1: normalized activity events --------------------------------------

test('run() emits normalized started/completed activity events for a tool_call', async () => {
  const runtime = makeRuntime();
  const activity = [];
  runtime.on('activity', event => activity.push(event));
  try {
    const result = await runtime.run('worker', { prompt: '[tool-call] do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(activity.length, 2);
    assert.equal(activity[0].status, 'started');
    assert.equal(activity[1].status, 'completed');
    for (const event of activity) {
      assert.equal(event.runtime, 'copilot');
      assert.equal(event.kind, 'command');
      assert.equal(event.id, 'call_1');
      assert.equal(event.sessionId, result.sessionId);
      assert.equal(event.turnId, result.turnId);
      assert.equal(event.command, 'echo fixture');
    }
    assert.equal(activity[0].endedAt, null);
    assert.ok(activity[1].endedAt >= activity[1].startedAt);
  } finally {
    await runtime.close();
  }
});

test('run() does not emit an activity event when there is no tool call', async () => {
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

test('with no permissionPolicy and no request listener, a permission request is denied by default', async () => {
  const runtime = makeRuntime();
  const decisions = [];
  runtime.on('notification', message => { if (message.method === 'fixture/permissionDecision') decisions.push(message.params.result); });
  try {
    const result = await runtime.run('worker', { prompt: '[permission] do something', schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0], { outcome: { outcome: 'selected', optionId: 'reject' } });
  } finally {
    await runtime.close();
  }
});

test('a configured permissionPolicy answers a permission request', async () => {
  const seen = [];
  const runtime = makeRuntime({
    permissionPolicy: request => { seen.push(request); return 'allow_once'; },
  });
  const decisions = [];
  runtime.on('notification', message => { if (message.method === 'fixture/permissionDecision') decisions.push(message.params.result); });
  try {
    await runtime.run('worker', { prompt: '[permission] do something', schema: SCHEMA }, '/tmp/work');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].runtime, 'copilot');
    assert.equal(seen[0].kind, 'command');
    assert.ok(seen[0].options.some(option => option.decision === 'allow_once'));
    assert.deepEqual(decisions[0], { outcome: { outcome: 'selected', optionId: 'allow' } });
  } finally {
    await runtime.close();
  }
});

test('an explicit request listener takes precedence over both policy and default', async () => {
  const runtime = makeRuntime({ permissionPolicy: () => 'reject_once' });
  const decisions = [];
  runtime.on('notification', message => { if (message.method === 'fixture/permissionDecision') decisions.push(message.params.result); });
  runtime.on('request', message => runtime.respond(message.id, { outcome: { outcome: 'selected', optionId: 'allow' } }));
  try {
    await runtime.run('worker', { prompt: '[permission] do something', schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(decisions[0], { outcome: { outcome: 'selected', optionId: 'allow' } }, 'the manual listener answer must win, not the policy');
  } finally {
    await runtime.close();
  }
});

// -- capability declaration --------------------------------------------------

test('capabilities() declares the Copilot parity surface', () => {
  const runtime = makeRuntime();
  const caps = runtime.capabilities();
  assert.equal(caps.setModel, true);
  assert.equal(caps.setMode, true);
  assert.equal(caps.availableCommands, true);
  assert.equal(caps.steer, false);
});

// -- B1: model selection ------------------------------------------------------

test('models() returns a normalized array, not the raw availableModels wrapper object', async () => {
  const runtime = makeRuntime();
  try {
    const models = await runtime.models();
    assert.ok(Array.isArray(models));
    assert.ok(models.some(m => m.modelId === 'fixture-model'));
  } finally {
    await runtime.close();
  }
});

test('run() applies an explicitly requested model via session/set_model (B1 fix)', async () => {
  const runtime = makeRuntime();
  const metas = [];
  try {
    await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work', (sessionId, meta) => metas.push(meta), { model: 'fixture-model-2' });
    assert.equal(metas[0].model, 'fixture-model-2');
  } finally {
    await runtime.close();
  }
});

test('setModel() applies a model to an existing session directly', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.setModel(first.sessionId, 'fixture-model-2');
    assert.equal(runtime.sessions.get(first.sessionId).currentModelId, 'fixture-model-2');
  } finally {
    await runtime.close();
  }
});

// -- B2: retire() uses session/close, not the non-existent session/delete ---

test('retire() calls session/close and reports deleted when the agent advertises sessionCapabilities.close', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(first.sessionId);
    const result = await runtime.retire(first.sessionId);
    assert.equal(result.status, 'deleted');
  } finally {
    await runtime.close();
  }
});

// -- P3: session modes --------------------------------------------------------

test('setMode() sends session/set_mode with the ACP mode URI', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.setMode(first.sessionId, 'plan');
  } finally {
    await runtime.close();
  }
});

test('setMode() rejects an unknown mode', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(() => runtime.setMode('sess_x', 'nonsense'), { code: 'invalid_mode' });
  } finally {
    await runtime.close();
  }
});

// -- P4: permission level control commands -----------------------------------

test("setPermissions('allow-all') sends the /allow-all control command", async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const result = await runtime.setPermissions(first.sessionId, 'allow-all');
    assert.match(result.text, /allow-all/);
  } finally {
    await runtime.close();
  }
});

test("setPermissions('read-only') is declared unsupported on Copilot", async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await assert.rejects(() => runtime.setPermissions(first.sessionId, 'read-only'), { code: 'capability_unsupported' });
  } finally {
    await runtime.close();
  }
});

// -- P5: autopilot goal --------------------------------------------------------

test('setGoal() sends the /autopilot control command with the objective and AI-credit cap', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const result = await runtime.setGoal(first.sessionId, 'Ship the feature', { maxCredits: 20 });
    assert.match(result.text, /Autopilot updated/);
  } finally {
    await runtime.close();
  }
});

// -- P6: compact ---------------------------------------------------------------

test('compact() sends the /compact control command', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const result = await runtime.compact(first.sessionId, 'focus on tests');
    assert.match(result.text, /compacted/);
  } finally {
    await runtime.close();
  }
});

// -- P7: usage ------------------------------------------------------------------

test('usage() prefers the structured usage_update notification over the /usage text reply', async () => {
  const runtime = makeRuntime();
  try {
    // The fixture pushes a structured usage_update after every normal turn (PART 4 correction) - this
    // must win over running /usage at all.
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const result = await runtime.usage(first.sessionId);
    assert.equal(result.backend, 'copilot');
    assert.equal(result.used, 12);
    assert.equal(result.size, 128000);
    assert.equal(result.cost, 0.05);
  } finally {
    await runtime.close();
  }
});

test('usage() falls back to parsing the /usage text reply when no structured update has arrived', async () => {
  const runtime = makeRuntime();
  try {
    // [no-usage-update] tells the fixture to suppress the structured notification for this turn.
    const first = await runtime.run('worker', { prompt: 'do something [no-usage-update]', schema: SCHEMA }, '/tmp/work');
    const result = await runtime.usage(first.sessionId);
    assert.equal(result.backend, 'copilot');
    assert.equal(result.requests, 3);
    assert.equal(result.aiUnits, 12);
  } finally {
    await runtime.close();
  }
});

// -- P8: steer is unsupported ---------------------------------------------------

test('steer() is declared unsupported on Copilot', async () => {
  const runtime = makeRuntime();
  await assert.rejects(() => runtime.steer('sess_x', 'go'), { code: 'capability_unsupported' });
});

// -- P9/P10: fork and listSessions ----------------------------------------------

test('fork() requests session/fork', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const forked = await runtime.fork(first.sessionId);
    assert.ok(forked.sessionId);
    assert.notEqual(forked.sessionId, first.sessionId);
  } finally {
    await runtime.close();
  }
});

test('listSessions() requests session/list', async () => {
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

// -- P12: streaming events --------------------------------------------------

test('run() emits normalized stream events for agent_message_chunk and tool_call content', async () => {
  const runtime = makeRuntime();
  const streamed = [];
  runtime.on('stream', event => streamed.push(event));
  try {
    await runtime.run('worker', { prompt: '[tool-call] do something', schema: SCHEMA }, '/tmp/work');
    assert.ok(streamed.some(e => e.kind === 'text'));
    assert.ok(streamed.some(e => e.kind === 'commandOutput' && e.delta === 'command output'));
    for (const event of streamed) assert.equal(event.runtime, 'copilot');
  } finally {
    await runtime.close();
  }
});

// -- P13: rich prompt input ---------------------------------------------------

test('run() passes input.blocks straight through to session/prompt when supplied', async () => {
  const runtime = makeRuntime();
  try {
    const result = await runtime.run('worker', { blocks: [{ type: 'text', text: 'do something' }], schema: SCHEMA }, '/tmp/work');
    assert.deepEqual(result.report, { ok: true, summary: 'Fixture output' });
  } finally {
    await runtime.close();
  }
});

// -- P14: available commands --------------------------------------------------

test('availableCommands() surfaces the available_commands_update notification', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    const commands = runtime.availableCommands(first.sessionId);
    assert.ok(commands.some(c => c.name === 'usage'));
    assert.ok(commands.some(c => c.name === 'autopilot'));
  } finally {
    await runtime.close();
  }
});

// -- Architecture batch PART 1: ban polling ---------------------------------------------------------

test('quiesce() awaits the running turn\'s settlement promise directly, not a membership-polling loop', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: '[delay] do something', schema: SCHEMA }, '/tmp/work');
    const startedAt = Date.now();
    await runtime.quiesce(first.sessionId);
    assert.ok(Date.now() - startedAt < 1000, 'quiesce() took too long - it may be polling on a fixed interval instead of awaiting a push event');
  } finally {
    await runtime.close();
  }
});

// -- Architecture batch PART 2: conversation lifetime and resumability ------------------------------

test('a completed turn never ends or retires the conversation - only an explicit retire() does', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    assert.ok(runtime.sessions.has(first.sessionId));
    const listed = await runtime.listSessions();
    assert.ok(listed.some(s => s.sessionId === first.sessionId));
    await runtime.quiesce(first.sessionId);
    await runtime.retire(first.sessionId);
  } finally {
    await runtime.close();
  }
});

test('run() transparently resumes a sessionId this runtime instance is no longer tracking, simulating an app restart', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work', () => {}, {}, { scope: 'issue-1' });
    await runtime.quiesce(first.sessionId);
    await runtime.retire(first.sessionId); // removed from this.sessions, simulating a restarted process
    assert.ok(!runtime.sessions.has(first.sessionId));
    const actions = [];
    const second = await runtime.run(
      'worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/work',
      (sessionId, meta) => { actions.push(meta.session.action); }, {}, { sessionId: first.sessionId, scope: 'issue-1' },
    );
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(actions[0], 'reused');
    await runtime.quiesce(second.sessionId);
    // A THIRD call against the now-adopted session must reuse normally, proving the adoption stuck.
    const third = await runtime.run('worker', { prompt: 'and again', schema: SCHEMA }, '/tmp/work', (sessionId, meta) => { actions.push(meta.session.action); }, {}, { sessionId: first.sessionId, scope: 'issue-1' });
    assert.equal(actions[1], 'reused');
    assert.equal(third.sessionId, first.sessionId);
    await runtime.quiesce(third.sessionId);
    await runtime.retire(third.sessionId);
  } finally {
    await runtime.close();
  }
});

test('sweepOrphans() releases only sessions older than maxAgeMs that this runtime is not tracking', async () => {
  const runtime = makeRuntime();
  try {
    const tracked = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(tracked.sessionId);
    // Simulate an orphan: the backend still has this session, but this runtime instance lost track of it
    // (e.g. crashed) without ever calling retire() - unlike retire(), this leaves the backend session alive.
    runtime.sessions.delete(tracked.sessionId);
    await runtime.request('debug/age-session', { sessionId: tracked.sessionId, ageMs: 30 * 24 * 60 * 60 * 1000 });
    const other = await runtime.run('worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/other');
    const result = await runtime.sweepOrphans({ maxAgeMs: 21 * 24 * 60 * 60 * 1000 });
    assert.ok(result.swept.includes(tracked.sessionId));
    assert.ok(!result.swept.includes(other.sessionId));
    await runtime.quiesce(other.sessionId);
    await runtime.retire(other.sessionId);
  } finally {
    await runtime.close();
  }
});

test('resume() marks replayed session/update history as replay, followed by a replayComplete event', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(first.sessionId);
    await runtime.retire(first.sessionId);
    const seen = [];
    runtime.on('event', envelope => { if (envelope.conversationId === first.sessionId) seen.push(envelope); });
    await runtime.resume(first.sessionId, '/tmp/work', []);
    const replayedStream = seen.find(e => e.type === 'stream' && e.replay === true);
    const completeEvent = seen.find(e => e.type === 'replayComplete');
    assert.ok(replayedStream, 'expected the replayed agent_message_chunk to be marked replay:true');
    assert.ok(completeEvent, 'expected a replayComplete envelope');
    await runtime.quiesce(first.sessionId);
    await runtime.retire(first.sessionId);
  } finally {
    await runtime.close();
  }
});

// This is the exact bug the resume-across-process-death smoke test caught live: calling resume()
// DIRECTLY (rather than letting run() auto-resume an unknown sessionId) left the session's reuse key
// permanently null, so a following run() could never adopt it and silently started a brand-new session,
// discarding the just-restored conversation.
test('a session explicitly resume()d by the caller (not auto-resumed by run()) is still reused by the next run() call', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: 'do something', schema: SCHEMA }, '/tmp/work');
    await runtime.quiesce(first.sessionId);
    await runtime.retire(first.sessionId);
    await runtime.resume(first.sessionId, '/tmp/work', []); // explicit resume(), NOT via run()'s auto-resume path
    const actions = [];
    const second = await runtime.run(
      'worker', { prompt: 'do something else', schema: SCHEMA }, '/tmp/work',
      (sessionId, meta) => { actions.push(meta.session.action); }, {}, { sessionId: first.sessionId },
    );
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(actions[0], 'reused');
    await runtime.quiesce(second.sessionId);
    await runtime.retire(second.sessionId);
  } finally {
    await runtime.close();
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
    await runtime.quiesce(first.sessionId);
    await runtime.retire(first.sessionId);
  } finally {
    await runtime.close();
  }
});

test('interrupt() during a turn publishes an "interrupted" turn lifecycle event', async () => {
  const runtime = makeRuntime();
  try {
    const phases = [];
    runtime.on('event', envelope => { if (envelope.type === 'turn') phases.push(envelope.data.phase); });
    const pending = runtime.run('worker', { prompt: '[cancel-only] do something', schema: SCHEMA }, '/tmp/work', sessionId => {
      setTimeout(() => runtime.interrupt(sessionId), 20);
    });
    await assert.rejects(pending, error => error.code === 'interrupted');
    assert.deepEqual(phases, ['started', 'interrupted']);
  } finally {
    await runtime.close();
  }
});

test('runtime.events(sessionId) is an async-iterable stream that a consumer can `for await` over', async () => {
  const runtime = makeRuntime();
  try {
    const first = await runtime.run('worker', { prompt: '[tool-call] do something', schema: SCHEMA }, '/tmp/work');
    const seen = [];
    for await (const envelope of runtime.events(first.sessionId)) {
      seen.push(envelope.type);
      if (envelope.type === 'turn' && envelope.data.phase === 'completed') break;
    }
    assert.ok(seen.includes('stream'));
    assert.ok(seen.includes('activity'));
    assert.ok(seen.includes('turn'));
    await runtime.quiesce(first.sessionId);
    await runtime.retire(first.sessionId);
  } finally {
    await runtime.close();
  }
});

// -- F9: distinguishing "out of money" from a generic refusal ------------------------------------------

test('F9: a plain refusal still raises a generic turn_failed fault, unaffected by the usage-limit heuristic', async () => {
  const runtime = makeRuntime();
  try {
    await assert.rejects(
      runtime.run('worker', { prompt: '[refusal] do something', schema: SCHEMA }, '/tmp/work'),
      error => { assert.equal(error.code, 'turn_failed'); return true; },
    );
  } finally {
    await runtime.close();
  }
});

test('F9: a refusal whose message reads like a quota/spend-cap wall raises the same usage_limit_exceeded fault as Codex (UNCONFIRMED heuristic)', async () => {
  const runtime = makeRuntime();
  try {
    const events = [];
    runtime.on('event', envelope => { if (envelope.type === 'budgetCeilingReached') events.push(envelope); });
    await assert.rejects(
      runtime.run('worker', { prompt: '[refusal-quota] do something', schema: SCHEMA }, '/tmp/work'),
      error => { assert.equal(error.code, 'usage_limit_exceeded'); return true; },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].data.source, 'backend');
  } finally {
    await runtime.close();
  }
});

