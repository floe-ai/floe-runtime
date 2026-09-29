import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COPILOT_BUILTIN_TOOL_MANIFEST,
  COPILOT_TOOL_MANIFEST_VERSION,
  CopilotEngineAccountAdapter,
  CopilotRuntime,
  copilotChildEnvironment,
  copilotToolCatalogForModel,
  createCopilotToolHook,
  defineTool,
  normalizeCopilotToolCall,
  normalizeCopilotPermissionRequest,
  resolveCopilotToolSelection,
} from 'floe-runtime/adapters/copilot';

test('Copilot package entry point exports its runtime, account adapter, and helpers', () => {
  assert.equal(typeof CopilotRuntime, 'function');
  assert.equal(typeof CopilotEngineAccountAdapter, 'function');
  assert.equal(typeof copilotChildEnvironment, 'function');
  assert.equal(typeof copilotToolCatalogForModel, 'function');
  assert.equal(typeof createCopilotToolHook, 'function');
  assert.equal(typeof defineTool, 'function');
  assert.equal(typeof COPILOT_TOOL_MANIFEST_VERSION, 'string');
  assert.equal(typeof COPILOT_BUILTIN_TOOL_MANIFEST, 'object');
  assert.equal(typeof normalizeCopilotToolCall, 'function');
  assert.equal(typeof normalizeCopilotPermissionRequest, 'function');
  assert.equal(typeof resolveCopilotToolSelection, 'function');
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
