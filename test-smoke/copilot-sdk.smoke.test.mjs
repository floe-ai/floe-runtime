// Real-runtime smoke tests for the preferred Copilot SDK adapter. These are
// separately gated and are never part of the unit suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCopilotSdkRuntime, probe } from './helpers.mjs';

const availability = await probe(makeCopilotSdkRuntime, 'Copilot SDK');
const skip = availability.ok ? false : availability.reason;

test('Copilot SDK smoke: starts the bundled runtime and lists available models', { skip }, async () => {
  const runtime = makeCopilotSdkRuntime();
  try {
    const info = await runtime.start();
    const models = await runtime.models();
    assert.equal(info.backend, 'copilot-sdk');
    assert.ok(models.length > 0, 'the SDK must return the authenticated model catalogue');
  } finally {
    await runtime.close();
  }
});
