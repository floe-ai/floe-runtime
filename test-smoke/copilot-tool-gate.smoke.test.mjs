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

const shell = process.platform === 'win32' ? 'powershell' : 'bash';
const shellTools = [shell, `read_${shell}`, `stop_${shell}`, `list_${shell}`];

function isolatedEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (['COPILOT_GITHUB_TOKEN', 'COPILOT_DISABLE_KEYTAR', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key.toUpperCase())) {
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
    enableExperimentalMode: false,
    enableSessionTelemetry: false,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    customAgents: [],
    coauthorEnabled: false,
    manageScheduleEnabled: false,
    mcpOAuthTokenStorage: 'in-memory',
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    includedBuiltinSkills: [],
    skillDirectories: [],
    instructionDirectories: [],
    pluginDirectories: [],
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory',
    enableOnDemandInstructionDiscovery: false,
    excludedBuiltinAgents: [],
    toolSearch: { enabled: false },
    memory: { enabled: false },
    mcpServers: {},
    requestExtensions: false,
    systemMessage: {
      mode: 'customize',
      sections: { environment_context: { action: 'remove' } },
    },
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
  const profile = join(root, 'floe-profile');
  const operatorHome = join(root, 'operator-home');
  const operatorCopilotHome = join(operatorHome, '.copilot');
  const workspace = join(root, 'workspace');
  const readable = join(workspace, 'readable.txt');
  const plantedMarker = 'FLOE_OPERATOR_CONFIGURATION_MUST_NOT_LOAD';
  const plantedHookMarker = join(workspace, 'operator-hook-must-not-run.txt');
  await mkdir(join(operatorCopilotHome, 'hooks'), { recursive: true });
  await mkdir(join(operatorCopilotHome, 'skills', 'operator-skill'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(readable, 'original');
  await writeFile(join(operatorCopilotHome, 'copilot-instructions.md'), plantedMarker);
  await writeFile(join(operatorCopilotHome, 'settings.json'), JSON.stringify({
    enableFileHooks: true,
    enableSkills: true,
  }));
  await writeFile(join(operatorCopilotHome, 'skills', 'operator-skill', 'SKILL.md'), `# operator-skill\n${plantedMarker}`);
  await writeFile(join(operatorCopilotHome, 'hooks', 'operator.json'), JSON.stringify({
    version: 1,
    hooks: {
      preToolUse: [{
        type: 'command',
        powershell: `Set-Content -LiteralPath '${plantedHookMarker}' -Value '${plantedMarker}'`,
      }],
    },
  }));

  const client = new CopilotClient({
    mode: 'copilot-cli',
    baseDirectory: profile,
    workingDirectory: workspace,
    useLoggedInUser: false,
    env: { ...isolatedEnvironment(), HOME: operatorHome, USERPROFILE: operatorHome },
    logLevel: 'error',
  });

  try {
    await client.start();
    const discoveredInstructions = await client.rpc.instructions.discover({ projectPaths: [workspace] });
    const discoveredHooks = await client.rpc.hooks.discover({ projectPaths: [workspace] });
    const discoveredSkills = await client.rpc.skills.discover({ projectPaths: [workspace] });
    assert.doesNotMatch(JSON.stringify(discoveredInstructions), new RegExp(plantedMarker));
    assert.doesNotMatch(JSON.stringify(discoveredHooks), /operator\.json/i);
    assert.doesNotMatch(JSON.stringify(discoveredSkills), /operator-skill/i);
    for (const scenario of [
      {
        model: 'claude-sonnet-5',
        names: [...shellTools, 'view', 'create', 'edit', 'web_fetch', 'grep', 'glob'],
      },
      {
        model: 'gpt-5.1-codex',
        names: [...shellTools, 'apply_patch', 'view', 'web_fetch', 'rg', 'glob'],
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
      const contextAttribution = await session.rpc.metadata.getContextAttribution();
      const skills = await session.rpc.skills.list();
      assert.doesNotMatch(JSON.stringify(contextAttribution), new RegExp(plantedMarker));
      assert.doesNotMatch(JSON.stringify(contextAttribution), /copilot-instructions\.md/i);
      assert.doesNotMatch(JSON.stringify(skills), /operator-skill/i);
      await missing(plantedHookMarker);
      const invocations = {
        [shell]: {
          command: process.platform === 'win32'
            ? `Set-Content -LiteralPath '${marker}' -Value bypass`
            : `printf bypass > '${marker}'`,
          description: 'denial marker',
        },
        [`read_${shell}`]: { shellId: 'missing-proof-shell', delay: 0 },
        [`stop_${shell}`]: { shellId: 'missing-proof-shell' },
        [`list_${shell}`]: {},
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
      await missing(plantedHookMarker);
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
    mode: 'copilot-cli',
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
