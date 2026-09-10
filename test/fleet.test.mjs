import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Fleet } from '../src/fleet.mjs';
import { CopilotRuntime } from '../src/adapters/copilot.mjs';
import { CodexRuntime } from '../src/adapters/codex.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const copilotFixture = path.join(dir, 'fake-copilot.mjs');
const codexFixture = path.join(dir, 'fake-codex.mjs');
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'] };

function makeFleet(options = {}) {
  return new Fleet({
    backends: {
      copilot: () => new CopilotRuntime({ executable: process.execPath, args: [copilotFixture], timeoutMs: 5000 }),
      codex: () => new CodexRuntime({ executable: process.execPath, args: [codexFixture], timeoutMs: 5000 }),
    },
    ...options,
  });
}

test('requestAgent() is instant and never blocks on capacity, even far past any shard limit', () => {
  const fleet = makeFleet({ maxSessionsPerProcess: 1, maxProcesses: 1 });
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' }));
  assert.equal(ids.size, 50); // every id is unique and registration never threw or queued
});

test('defaults to Copilot as the first-call backend, Codex remains fully selectable per agent', async () => {
  const fleet = makeFleet();
  try {
    const copilotAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const codexAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work', backend: 'codex' });
    assert.equal(fleet.agent(copilotAgent).backend, 'copilot');
    assert.equal(fleet.agent(codexAgent).backend, 'codex');
    const [copilotResult, codexResult] = await Promise.all([
      fleet.run(copilotAgent, { prompt: 'hello', schema: SCHEMA }),
      fleet.run(codexAgent, { prompt: 'hello', schema: SCHEMA }),
    ]);
    assert.deepEqual(copilotResult.report, { ok: true, summary: 'Fixture output' });
    assert.deepEqual(codexResult.report, { ok: true, summary: 'Fixture output' });
  } finally {
    await fleet.close();
  }
});

test('capabilities() gives a mixed-fleet view without silently degrading unsupported methods', async () => {
  const fleet = makeFleet();
  try {
    const copilotAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const codexAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work', backend: 'codex' });
    await fleet.run(codexAgent, { prompt: 'hello', schema: SCHEMA });
    assert.equal(fleet.capabilities('copilot').fleetMode, true);
    assert.equal(fleet.capabilities('codex').fleetMode, false);
    assert.deepEqual(fleet.capabilities(copilotAgent), fleet.capabilities('copilot'));
    await assert.rejects(fleet.fleetMode(codexAgent, 'go'), error => error.code === 'capability_unsupported');
    assert.throws(() => fleet.capabilities('nonexistent-agent-or-backend'), error => error.code === 'agent_unknown');
  } finally {
    await fleet.close();
  }
});

test('S2: shard saturation queues new agent requests instead of spawning without bound', async () => {
  const fleet = makeFleet({ maxSessionsPerProcess: 1, maxProcesses: 1 });
  try {
    const agentA = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const agentB = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const admissions = [];
    fleet.on('admission', event => admissions.push(event.agentId));

    const runA = fleet.run(agentA, { prompt: '[delay] first', schema: SCHEMA });
    // Give A a moment to actually acquire the only shard slot before B is requested.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fleet.shards.size, 1, 'the only shard should be occupied by A already');

    const runB = fleet.run(agentB, { prompt: 'second', schema: SCHEMA });
    await new Promise(resolve => setTimeout(resolve, 20));
    // B must still be queued - no second shard/process should have been spawned.
    assert.equal(fleet.shards.size, 1, 'saturation must queue, never spawn past maxProcesses');
    assert.equal(fleet.queue.length, 1);
    assert.deepEqual(admissions, [agentA]);

    await runA;
    // Freeing A's TURN does not free a shard slot (only retire() does) - B must remain queued.
    assert.equal(fleet.queue.length, 1);
    await fleet.retireAgent(agentA);
    const resultB = await runB;
    assert.deepEqual(resultB.report, { ok: true, summary: 'Fixture output' });
    assert.deepEqual(admissions, [agentA, agentB]);
  } finally {
    await fleet.close();
  }
});

test('S2: a shard death recovers a persistent agent via resume() and reports an ephemeral agent as permanently lost', async () => {
  const fleet = makeFleet({ maxSessionsPerProcess: 8, maxProcesses: 4 });
  try {
    const persistentAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const ephemeralAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work', ephemeral: true });

    await fleet.run(persistentAgent, { prompt: 'establish', schema: SCHEMA }, sessionId => { fleet.agents.get(persistentAgent).sessionId = sessionId; });
    await fleet.run(ephemeralAgent, { prompt: 'establish', schema: SCHEMA, }, sessionId => { fleet.agents.get(ephemeralAgent).sessionId = sessionId; }, { ephemeral: true });

    const shardId = fleet.agents.get(persistentAgent).shardId;
    assert.equal(fleet.agents.get(ephemeralAgent).shardId, shardId, 'test setup expects both agents sharing one shard');
    const shard = fleet.shards.get(shardId);

    const lostEvents = [];
    const recoveredEvents = [];
    fleet.on('shardLost', event => lostEvents.push(event));
    fleet.on('event', envelope => {
      if (envelope.type === 'agentRecovered') recoveredEvents.push(envelope);
    });
    const agentLost = new Promise(resolve => {
      fleet.on('event', envelope => { if (envelope.type === 'agentLost') resolve(envelope); });
    });

    await shard.runtime.request('debug/crash', {}).catch(() => {}); // the fixture exits before replying - a "lost" connection, not a graceful response

    const lostEnvelope = await agentLost;
    assert.equal(lostEnvelope.data.agentId, ephemeralAgent);
    assert.equal(lostEnvelope.data.recoverable, false);
    assert.equal(fleet.agents.get(ephemeralAgent).status, 'lost');
    await assert.rejects(fleet.run(ephemeralAgent, { prompt: 'x', schema: SCHEMA }), error => error.code === 'agent_lost');

    assert.equal(lostEvents.length, 1);
    assert.deepEqual(new Set(lostEvents[0].agentIds), new Set([persistentAgent, ephemeralAgent]));

    // Wait for the persistent agent's automatic recovery (resume() on a fresh shard).
    for (let i = 0; i < 100 && fleet.agents.get(persistentAgent).status !== 'ready'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(fleet.agents.get(persistentAgent).status, 'ready');
    assert.notEqual(fleet.agents.get(persistentAgent).shardId, shardId);
    assert.equal(recoveredEvents.length, 1);
  } finally {
    await fleet.close();
  }
});

test('S3: the fleet budget ceiling blocks admission of new turns once reached', async () => {
  const fleet = makeFleet({ budget: { ceiling: 0.1, warnAt: [0.5] } });
  try {
    const agent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const warnings = [];
    let ceilingEvent = null;
    fleet.on('budgetWarning', event => warnings.push(event));
    fleet.on('budgetCeilingReached', event => { ceilingEvent = event; });

    await fleet.run(agent, { prompt: '[cost=0.06] first', schema: SCHEMA });
    assert.ok(warnings.length >= 1, 'crossing the 50% threshold must emit a warning event');
    assert.equal(fleet.budget.exceeded, false);

    await fleet.run(agent, { prompt: '[cost=0.06] second', schema: SCHEMA });
    assert.equal(fleet.budget.exceeded, true);
    assert.ok(ceilingEvent, 'reaching the ceiling must emit a distinct budgetCeilingReached event');

    await assert.rejects(fleet.run(agent, { prompt: 'third', schema: SCHEMA }), error => error.code === 'budget_exceeded');
  } finally {
    await fleet.close();
  }
});

test('S4: the concurrency queue drains purely from turn-settled events, not a timer', async () => {
  const fleet = makeFleet({ maxConcurrentTurns: 1 });
  try {
    const agentA = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const agentB = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const admittedAt = {};
    fleet.on('admission', event => { admittedAt[event.agentId] = process.hrtime.bigint(); });

    const runA = fleet.run(agentA, { prompt: '[delay] first', schema: SCHEMA }); // ~200ms in the fixture
    const runB = fleet.run(agentB, { prompt: 'second', schema: SCHEMA });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fleet.queue.length, 1, 'B must be queued while A is the sole active turn');

    await runA;
    const settledAt = process.hrtime.bigint(); // the instant A's turn actually settles
    await runB;
    // B must be admitted immediately upon A's settlement (well under the fixture's own 200ms delay),
    // proving the drain fired from the 'turn' settled event rather than from a periodic re-check.
    const deltaMs = Number(admittedAt[agentB] - settledAt) / 1e6;
    assert.ok(deltaMs < 100, `expected B to be admitted immediately on A's settlement, took ${deltaMs}ms`);
  } finally {
    await fleet.close();
  }
});

test('S1: the unified fleet event stream tags every event with agentId and backend', async () => {
  const fleet = makeFleet();
  try {
    const agent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const seen = [];
    fleet.on('event', envelope => seen.push(envelope));
    await fleet.run(agent, { prompt: 'hello', schema: SCHEMA });
    assert.ok(seen.length > 0);
    for (const envelope of seen) {
      assert.equal(envelope.conversationId, agent);
      assert.equal(envelope.data.agentId, agent);
      assert.equal(envelope.data.backend, 'copilot');
    }
  } finally {
    await fleet.close();
  }
});

test('S5: fleetMode() is a distinct capability from S1\'s fleet-of-sessions model', async () => {
  const fleet = makeFleet();
  try {
    const agent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    await fleet.run(agent, { prompt: 'hello', schema: SCHEMA });
    const result = await fleet.fleetMode(agent, 'fan out three subagents');
    assert.equal(result.text, 'Fleet mode enabled.');
  } finally {
    await fleet.close();
  }
});

test('S6: scheduleRecurring()/scheduleOnce() are exposed and unsupported on Codex', async () => {
  const fleet = makeFleet();
  try {
    const copilotAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    const codexAgent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work', backend: 'codex' });
    await fleet.run(copilotAgent, { prompt: 'hello', schema: SCHEMA });
    await fleet.run(codexAgent, { prompt: 'hello', schema: SCHEMA });
    const every = await fleet.scheduleRecurring(copilotAgent, '1h', 'check status');
    assert.equal(every.text, 'Recurring schedule set.');
    const after = await fleet.scheduleOnce(copilotAgent, '30m', 'follow up');
    assert.equal(after.text, 'One-shot schedule set.');
    await assert.rejects(fleet.scheduleRecurring(codexAgent, '1h', 'x'), error => error.code === 'capability_unsupported');
    await assert.rejects(fleet.scheduleOnce(codexAgent, '30m', 'x'), error => error.code === 'capability_unsupported');
  } finally {
    await fleet.close();
  }
});

test('retireAgent() is the only thing that ends an agent - a settled turn never tears it down', async () => {
  const fleet = makeFleet();
  try {
    const agent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    await fleet.run(agent, { prompt: 'first', schema: SCHEMA });
    assert.equal(fleet.agents.get(agent).status, 'ready');
    await fleet.run(agent, { prompt: 'second', schema: SCHEMA }); // a second turn on the same agent must still work
    assert.equal(fleet.agents.has(agent), true);
    await fleet.retireAgent(agent);
    assert.equal(fleet.agents.has(agent), false);
  } finally {
    await fleet.close();
  }
});

test('F9: a backend-reported spend/quota wall (source: "backend") trips the SAME admission-control gate as our own budget ceiling', async () => {
  const fleet = makeFleet(); // no ceiling configured at all - the backend's own report must still gate admission
  try {
    const agent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work', backend: 'codex' });
    let ceilingEvent = null;
    fleet.on('budgetCeilingReached', event => { ceilingEvent = event; });
    await assert.rejects(
      fleet.run(agent, { prompt: '[usage-limit] do something', schema: SCHEMA }),
      error => { assert.equal(error.code, 'usage_limit_exceeded'); return true; },
    );
    assert.ok(ceilingEvent, 'a backend-reported usage limit must emit the same budgetCeilingReached signal our own ceiling uses');
    assert.equal(ceilingEvent.source, 'backend');
    assert.equal(fleet.budget.exceeded, true);
    // Once tripped, admission control must refuse NEW turns fleet-wide, exactly like our own ceiling.
    const other = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work' });
    await assert.rejects(fleet.run(other, { prompt: 'x', schema: SCHEMA }), error => error.code === 'budget_exceeded');
  } finally {
    await fleet.close();
  }
});

test('F11: a shard death recovers a persistent Codex agent AND re-applies its last known goal on the fresh shard', async () => {
  const fleet = makeFleet({ maxSessionsPerProcess: 8, maxProcesses: 4 });
  try {
    const agent = fleet.requestAgent({ role: 'worker', cwd: '/tmp/work', backend: 'codex' });
    await fleet.run(agent, { prompt: 'establish', schema: SCHEMA }, sessionId => { fleet.agents.get(agent).sessionId = sessionId; });
    await fleet.setGoal(agent, 'Ship the feature.');
    assert.equal(fleet.agents.get(agent).lastGoal, 'Ship the feature.');

    const shardId = fleet.agents.get(agent).shardId;
    const shard = fleet.shards.get(shardId);
    const goalReapplied = new Promise(resolve => {
      fleet.on('event', envelope => { if (envelope.type === 'goalReapplied' && envelope.conversationId === agent) resolve(envelope); });
    });
    await shard.runtime.request('debug/crash', {}).catch(() => {});
    const envelope = await goalReapplied;
    assert.equal(envelope.data.objective, 'Ship the feature.');
    for (let i = 0; i < 100 && fleet.agents.get(agent).status !== 'ready'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(fleet.agents.get(agent).status, 'ready');
  } finally {
    await fleet.close();
  }
});

