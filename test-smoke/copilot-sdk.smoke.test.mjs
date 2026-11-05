// Real-runtime smoke tests for the preferred Copilot SDK adapter. These are
// separately gated and are never part of the unit suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotEngineAccountAdapter } from '../src/adapters/copilot.mjs';
import { makeCopilotSdkRuntime, probe } from './helpers.mjs';

const baseDirectory = join(tmpdir(), 'floe-runtime-copilot-smoke');
const accountAdapter = new CopilotEngineAccountAdapter({ clientOptions: { baseDirectory } });
const readiness = await accountAdapter.check();
await accountAdapter.close();
const expectedAccount = readiness.phase === 'ready' ? readiness.account : null;
const makeRuntime = () => makeCopilotSdkRuntime({
  clientOptions: { baseDirectory },
  expectedAccount,
});
const availability = expectedAccount
  ? await probe(makeRuntime, 'Copilot SDK')
  : { ok: false, reason: readiness.message };
const skip = availability.ok ? false : availability.reason;

test('Copilot SDK smoke: starts the bundled runtime and lists available models', { skip }, async () => {
  const runtime = makeRuntime();
  try {
    const info = await runtime.start();
    const models = await runtime.models();
    assert.equal(info.backend, 'copilot-sdk');
    assert.ok(models.length > 0, 'the SDK must return the authenticated model catalogue');
  } finally {
    await runtime.close();
  }
});

// gpt-5-mini, not CHEAP_COPILOT_MODEL: Claude Haiku 4.5 does not support reasoning effort.
const EFFORT_MODEL = 'gpt-5-mini';
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

test('Copilot SDK smoke: reasoning effort reaches Copilot on create and on a live switch', { skip }, async () => {
  const runtime = makeRuntime();
  try {
    const input = { prompt: 'Reply with {"ok":true} only.', schema: SCHEMA };
    const first = await runtime.run('worker', input, tmpdir(), () => {}, { model: EFFORT_MODEL, effort: 'low' });
    assert.equal(first.effort, 'low', 'Copilot must report the effort it used for the turn');
    await runtime.setModel(first.sessionId, EFFORT_MODEL, { effort: 'high' });
    const second = await runtime.run('worker', input, tmpdir(), () => {}, {}, { sessionId: first.sessionId });
    assert.equal(second.effort, 'high');
    await assert.rejects(
      runtime.setModel(first.sessionId, EFFORT_MODEL, { effort: 'max' }),
      error => error.code === 'copilot_effort_unavailable',
    );
  } finally {
    await runtime.close();
  }
});
