// Real-runtime smoke tests for Copilot compaction (README: "Compaction"). Separately gated; never
// part of the unit suite. Each compaction is its own model call, so these spend credits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotEngineAccountAdapter } from '../src/adapters/copilot.mjs';
import { CHEAP_COPILOT_MODEL, makeCopilotSdkRuntime, probe } from './helpers.mjs';

const baseDirectory = join(tmpdir(), 'floe-runtime-copilot-smoke');
const accountAdapter = new CopilotEngineAccountAdapter({ clientOptions: { baseDirectory } });
const readiness = await accountAdapter.check();
await accountAdapter.close();
const expectedAccount = readiness.phase === 'ready' ? readiness.account : null;
const makeRuntime = (options = {}) => makeCopilotSdkRuntime({
  clientOptions: { baseDirectory },
  expectedAccount,
  ...options,
});
const availability = expectedAccount
  ? await probe(makeRuntime, 'Copilot SDK')
  : { ok: false, reason: readiness.message };
const skip = availability.ok ? false : availability.reason;

const SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
const settings = { model: CHEAP_COPILOT_MODEL };
const ask = (runtime, prompt, cwd, options, onSession = () => {}) =>
  runtime.run('worker', { prompt, schema: SCHEMA }, cwd, onSession, settings, options);
const padding = lines => Array.from({ length: lines }, (_, i) =>
  `Line ${i}: the ${['red', 'blue', 'green', 'amber'][i % 4]} fox number ${i * 7919 % 10007} jumped.`).join('\n');

/** Resolves with the first compaction event matching `match`; rejects after `timeoutMs`. */
function nextCompaction(runtime, match, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { runtime.off('compaction', listener); reject(new Error('No matching compaction event.')); }, timeoutMs);
    const listener = event => {
      if (!match(event)) return;
      clearTimeout(timer);
      runtime.off('compaction', listener);
      resolve(event);
    };
    runtime.on('compaction', listener);
  });
}

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'floe-compaction-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('Copilot compaction smoke: manual compact with focus, then compact and continue after a restart', { skip, timeout: 600_000 }, async t => {
  const cwd = await workspace(t);
  let runtime = makeRuntime();
  let sessionId;
  try {
    assert.equal(runtime.capabilities.compact, true);
    const first = await ask(runtime, `${padding(1500)}\nDesign decision D1: use SQLite. Rejected option: Postgres. Reply OK.`, cwd);
    sessionId = first.sessionId;
    await ask(runtime, 'Design decision D2: no polling. Reply OK.', cwd, { sessionId });

    const completed = nextCompaction(runtime, event => event.sessionId === sessionId && event.phase !== 'started', 180_000);
    const result = await runtime.compact(sessionId, 'keep design decisions and rejected options');
    assert.equal(result.success, true, result.error ?? 'compaction failed');
    assert.ok(result.summary?.length > 0, 'a successful compaction returns its summary');
    assert.ok(result.tokensRemoved > 0, `expected tokens freed, got ${result.tokensRemoved}`);
    const event = await completed;
    assert.equal(event.phase, 'completed');
    assert.equal(event.trigger, 'manual');
    assert.equal(event.focus, 'keep design decisions and rejected options');
  } finally {
    await runtime.close();
  }

  runtime = makeRuntime();
  try {
    await ask(runtime, `${padding(1500)}\nDesign decision D3: events over polling. Reply OK.`, cwd, { sessionId });
    const again = await runtime.compact(sessionId, 'keep design decisions');
    assert.equal(again.success, true, again.error ?? 'compaction after restart failed');
  } finally {
    await runtime.close();
  }

  runtime = makeRuntime();
  try {
    let meta;
    const next = await ask(runtime, 'Which database did we choose and which did we reject?', cwd, { sessionId }, (_id, info) => { meta = info; });
    assert.equal(next.sessionId, sessionId);
    assert.equal(meta.session.action, 'reused');
    assert.match(next.report.reply, /sqlite/i);
  } finally {
    await runtime.close();
  }
});

// 0.1, not the request's 0.3: the mechanism is the same and a lower threshold needs far less padding (spend).
const THRESHOLD = 0.1;

test('Copilot compaction smoke: infiniteSessions controls automatic compaction', { skip, timeout: 900_000 }, async t => {
  for (const [label, infiniteSessions, expectCompaction] of [
    ['off', { enabled: false }, false],
    ['low threshold', { enabled: true, backgroundCompactionThreshold: THRESHOLD }, true],
  ]) {
    await t.test(label, async t => {
      const cwd = await workspace(t);
      const runtime = makeRuntime({ infiniteSessions });
      const seen = [];
      runtime.on('compaction', event => seen.push(event));
      try {
        const background = expectCompaction
          ? nextCompaction(runtime, event => event.trigger === 'threshold' && event.phase === 'completed', 600_000)
          : null;
        const first = await ask(runtime, `${padding(2500)}\nReply OK.`, cwd);
        await ask(runtime, `${padding(2500)}\nReply OK.`, cwd, { sessionId: first.sessionId });
        if (background) {
          const event = await background;
          assert.ok(event.tokensRemoved > 0);
        } else {
          assert.deepEqual(seen, [], 'automatic compaction ran while disabled');
        }
      } finally {
        await runtime.close();
      }
    });
  }
});
