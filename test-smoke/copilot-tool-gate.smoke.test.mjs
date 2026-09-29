import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient } from '@github/copilot-sdk';
import {
  createCopilotToolHook,
  prepareCopilotToolSession,
  resolveCopilotToolSelection,
} from '../src/adapters/copilot-tools.mjs';

function isolatedEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return environment;
}

async function missing(path) {
  await assert.rejects(access(path));
}

async function sessionFor(client, workspace, model, selection, hook, permissionRequests) {
  const session = await client.createSession({
    model,
    workingDirectory: workspace,
    availableTools: selection.filters,
    excludedTools: [],
    enableConfigDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    includedBuiltinSkills: [],
    excludedBuiltinAgents: [],
    toolSearch: { enabled: false },
    memory: { enabled: false },
    mcpServers: {},
    requestExtensions: false,
    hooks: { onPreToolUse: hook },
    onPermissionRequest(request) {
      permissionRequests.push(request);
      return { kind: 'reject', feedback: '{"code":"unexpected_permission_path"}' };
    },
  });
  await prepareCopilotToolSession(session, selection, workspace);
  return session;
}

test('pinned Copilot runtime gates every exposed work tool before side effects', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'floe-copilot-tools-'));
  const profile = join(root, 'profile');
  const workspace = join(root, 'workspace');
  const readable = join(workspace, 'readable.txt');
  await mkdir(workspace);
  await writeFile(readable, 'original');

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
    for (const scenario of [
      {
        model: 'claude-sonnet-5',
        names: ['powershell', 'read_powershell', 'stop_powershell', 'list_powershell', 'view', 'create', 'edit', 'web_fetch', 'grep', 'glob'],
      },
      {
        model: 'gpt-5.1-codex',
        names: ['powershell', 'read_powershell', 'stop_powershell', 'list_powershell', 'apply_patch', 'view', 'web_fetch', 'rg', 'glob'],
      },
    ]) {
      const marker = join(workspace, `${scenario.model}-must-not-exist.txt`);
      const requests = [];
      const seen = [];
      const selection = resolveCopilotToolSelection({
        model: scenario.model,
        availableTools: scenario.names.map(name => `builtin:${name}`),
      });
      const hook = createCopilotToolHook({
        selection,
        timeoutMs: 1_000,
        toolCallId: () => `proof-${seen.length + 1}`,
        policy(request) {
          seen.push(request);
          return {
            decision: 'reject_once',
            refusal: { rule_id: 'proof.denied', reason: `Denied ${request.title}` },
          };
        },
      });
      const session = await sessionFor(client, workspace, scenario.model, selection, hook, requests);
      const invocations = {
        powershell: { command: `Set-Content -LiteralPath '${marker}' -Value bypass`, description: 'denial marker' },
        read_powershell: { shellId: 'missing-proof-shell', delay: 0 },
        stop_powershell: { shellId: 'missing-proof-shell' },
        list_powershell: {},
        view: { path: readable },
        create: { path: marker, file_text: 'bypass' },
        edit: { path: readable, old_str: 'original', new_str: 'bypass' },
        apply_patch: `*** Begin Patch\n*** Add File: ${marker}\n+bypass\n*** End Patch`,
        web_fetch: { url: 'https://example.invalid/floe-denial-proof' },
        grep: { pattern: 'original', paths: workspace },
        rg: { pattern: 'original', paths: workspace },
        glob: { pattern: '**/*.txt', paths: workspace },
      };
      for (const name of scenario.names) {
        const result = await session.rpc.tools.execute({
          name,
          arguments: invocations[name],
          toolCallId: `native-${name}`,
        });
        assert.equal(result.resultType, 'denied', `${scenario.model}/${name} was not denied`);
        assert.match(result.textResultForLlm, new RegExp(`Denied ${name}`));
      }
      assert.deepEqual(seen.map(request => request.title), scenario.names);
      assert.equal(requests.length, 0, 'a governed call escaped to onPermissionRequest');
      await missing(marker);
      assert.equal(await readFile(readable, 'utf8'), 'original');
      await session.disconnect();
    }
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('pinned Copilot hook errors fail closed and unrestricted default allows', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'floe-copilot-hook-errors-'));
  const profile = join(root, 'profile');
  const workspace = join(root, 'workspace');
  const deniedMarker = join(workspace, 'denied.txt');
  const allowedMarker = join(workspace, 'allowed.txt');
  await mkdir(workspace);
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
    const selection = resolveCopilotToolSelection({
      model: 'claude-sonnet-5',
      availableTools: ['builtin:create'],
    });
    const requests = [];
    const denied = await sessionFor(
      client,
      workspace,
      'claude-sonnet-5',
      selection,
      createCopilotToolHook({
        selection,
        timeoutMs: 1_000,
        policy() { throw new Error('simulated policy failure'); },
      }),
      requests,
    );
    const deniedResult = await denied.rpc.tools.execute({
      name: 'create',
      arguments: { path: deniedMarker, file_text: 'bypass' },
      toolCallId: 'native-denied',
    });
    assert.equal(deniedResult.resultType, 'denied');
    assert.match(deniedResult.textResultForLlm, /simulated policy failure/);
    await missing(deniedMarker);
    assert.equal(requests.length, 0);
    await denied.disconnect();

    const allowed = await sessionFor(
      client,
      workspace,
      'claude-sonnet-5',
      selection,
      createCopilotToolHook({ selection, timeoutMs: 1_000 }),
      requests,
    );
    const allowedResult = await allowed.rpc.tools.execute({
      name: 'create',
      arguments: { path: allowedMarker, file_text: 'allowed by default' },
      toolCallId: 'native-allowed',
    });
    assert.equal(allowedResult.resultType, 'success');
    assert.equal(await readFile(allowedMarker, 'utf8'), 'allowed by default');
    await allowed.disconnect();
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});
