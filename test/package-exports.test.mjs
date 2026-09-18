import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CopilotRuntime, defineTool } from 'floe-runtime/adapters/copilot';

test('Copilot package entry point exports the SDK runtime and direct-tool helper', () => {
  assert.equal(typeof CopilotRuntime, 'function');
  assert.equal(typeof defineTool, 'function');
});

test('Copilot SDK declarations and README match the unsupported command contract', async () => {
  const [declarations, readme] = await Promise.all([
    readFile(new URL('../src/adapters/copilot.d.mts', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  assert.match(declarations, /availableCommands\(sessionId: string\): never;/);
  assert.match(declarations, /fleetMode: false;/);
  assert.match(declarations, /scheduleRecurring: false;/);
  assert.match(declarations, /scheduleOnce: false;/);
  assert.match(readme, /\| `availableCommands\(id\)` \| ❌ unsupported \| ❌ unsupported \|/);
});
