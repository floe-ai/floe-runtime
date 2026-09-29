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
