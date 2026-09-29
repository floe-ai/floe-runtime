import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient } from '@github/copilot-sdk';
import {
  prepareCopilotToolSession,
  resolveCopilotToolSelection,
} from '../src/adapters/copilot-tools.mjs';

const BUILT_INS = ['powershell', 'apply_patch', 'view', 'rg', 'glob', 'web_fetch'];

function isolatedEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return environment;
}

test('pinned Copilot runtime denies every governed built-in before side effects', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'floe-copilot-tools-'));
  const profile = join(root, 'profile');
  const workspace = join(root, 'workspace');
  const marker = join(workspace, 'must-not-exist.txt');
  await writeFile(join(root, 'placeholder'), '');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
  await writeFile(join(workspace, 'readable.txt'), 'needle');

  const requests = [];
  const selection = resolveCopilotToolSelection({
    availableTools: BUILT_INS.map(name => `builtin:${name}`),
  });
  const client = new CopilotClient({
    mode: 'empty',
    baseDirectory: profile,
    workingDirectory: workspace,
    useLoggedInUser: false,
    env: isolatedEnvironment(),
    logLevel: 'error',
  });

  try {
    await client.start();
    const session = await client.createSession({
      model: 'claude-sonnet-4.5',
      workingDirectory: workspace,
      availableTools: selection.filters,
      excludedTools: [],
      enableConfigDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
      includedBuiltinSkills: [],
      toolSearch: { enabled: false },
      memory: { enabled: false },
      mcpServers: {},
      requestExtensions: false,
      onPermissionRequest(request) {
        requests.push(request);
        return { kind: 'reject', feedback: '{"code":"tool_policy_denied"}' };
      },
    });
    await prepareCopilotToolSession(session, selection, workspace);

    const invocations = [
      ['powershell', { command: `Set-Content -LiteralPath '${marker}' -Value denied`, description: 'create denial marker' }],
      ['apply_patch', { patch: `*** Begin Patch\n*** Add File: ${marker}\n+denied\n*** End Patch\n` }],
      ['view', { path: join(workspace, 'readable.txt') }],
      ['rg', { pattern: 'needle', paths: workspace }],
      ['glob', { pattern: '**/*.txt', path: workspace }],
      ['web_fetch', { url: 'https://example.invalid/floe-denial-proof' }],
    ];
    for (const [name, args] of invocations) {
      const before = requests.length;
      await session.rpc.tools.execute({ name, arguments: args, toolCallId: `proof-${name}` });
      assert.equal(requests.length, before + 1, `${name} bypassed onPermissionRequest`);
      assert.equal(requests.at(-1).toolCallId, `proof-${name}`);
    }

    await assert.rejects(access(marker));
    await session.disconnect();
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});
