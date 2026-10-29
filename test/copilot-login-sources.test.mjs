import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { CopilotEngineAccountAdapter, CopilotRuntime } from '../src/adapters/copilot.mjs';
import { saveLoginChoice } from '../src/adapters/copilot-login-sources.mjs';
import { githubApiBase } from '../src/adapters/github-user.mjs';
import { FakeCopilotClient } from './fake-copilot-sdk.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = /gh-secret|env-secret|other-secret/;
const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['ok', 'summary'],
};

function scratchDirectory(t) {
  const directory = mkdtempSync(path.join(TEST_DIRECTORY, '.login-choice-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function choiceFile(directory) {
  return path.join(directory, 'floe-login.json');
}

class FakeGitHubCli extends EventEmitter {
  constructor(output, code = 0) {
    super();
    this.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (output) this.stdout.emit('data', Buffer.from(`${output}\n`));
      this.emit('close', code);
    });
  }
}

class FakeClient {
  constructor(auth, log) {
    this.auth = auth;
    this.log = log;
  }

  async start() { this.log.push('start'); }
  async ping() {}
  async getAuthStatus() { return this.auth; }
  async listModels() { return [{ id: 'gpt-5-mini' }]; }
  async stop() { this.log.push('stop'); }
}

const SIGNED_OUT = { isAuthenticated: false };
const IDENTITIES = {
  'gh-secret': { isAuthenticated: true, authType: 'token', login: 'cli-user', host: 'https://github.com' },
  'env-secret': { isAuthenticated: true, authType: 'token', login: 'env-user', host: 'https://github.com' },
};

function loginAdapter(t, {
  acceptedLogins,
  environment = { PATH: 'C:\\tools', GH_TOKEN: 'env-secret', GITHUB_TOKEN: 'other-secret' },
  ghOutput = 'gh-secret',
  baseDirectory = scratchDirectory(t),
  connection,
  appAuth = SIGNED_OUT,
  identities = IDENTITIES,
  fetch,
} = {}) {
  const optionsSeen = [];
  const spawnCalls = [];
  const log = [];
  const states = [];
  const adapter = new CopilotEngineAccountAdapter({
    clientFactory: options => {
      optionsSeen.push(options);
      const auth = options.gitHubToken ? identities[options.gitHubToken] ?? SIGNED_OUT : appAuth;
      return new FakeClient(auth, log);
    },
    clientOptions: { baseDirectory, ...(connection ? { connection } : {}) },
    acceptedLogins,
    environment,
    fetch,
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return ghOutput === null ? new FakeGitHubCli('', 1) : new FakeGitHubCli(ghOutput);
    },
  });
  adapter.on('state', state => states.push(state));
  return { adapter, optionsSeen, spawnCalls, log, states, baseDirectory };
}

test('default accepted logins keep app-only readiness and never ask gh', async t => {
  const { adapter, optionsSeen, spawnCalls } = loginAdapter(t);

  const state = await adapter.check();

  assert.equal(state.authentication, 'signed_out');
  assert.equal(state.message, 'Copilot is not signed in on this machine.');
  assert.equal('existingLogins' in state, false);
  assert.equal(spawnCalls.length, 0);
  assert.equal(optionsSeen.length, 1);
  assert.equal(optionsSeen[0].gitHubToken, undefined);
  await assert.rejects(adapter.useExistingLogin('github-cli'), { code: 'login_source_not_accepted' });
});

test('signed-out readiness offers GitHub CLI and environment logins without exposing tokens', async t => {
  const { adapter, optionsSeen, spawnCalls, log, states } = loginAdapter(t, {
    acceptedLogins: ['app', 'github-cli', 'environment'],
  });

  const state = await adapter.check();

  assert.equal(state.authentication, 'signed_out');
  assert.equal(state.action, 'sign_in');
  assert.deepEqual(state.existingLogins, [
    { source: 'github-cli', login: 'cli-user', host: 'https://github.com' },
    { source: 'environment', login: 'env-user', host: 'https://github.com' },
  ]);
  const [command, args, spawnOptions] = spawnCalls[0];
  assert.equal(command, 'gh');
  assert.deepEqual(args, ['auth', 'token']);
  assert.equal(spawnOptions.shell, undefined);
  assert.equal(spawnOptions.env.GH_TOKEN, undefined);
  assert.equal(spawnOptions.env.PATH, 'C:\\tools');
  assert.deepEqual(optionsSeen.map(options => options.gitHubToken), [undefined, 'gh-secret', 'env-secret']);
  assert.equal(log.filter(entry => entry === 'start').length, log.filter(entry => entry === 'stop').length);
  assert.doesNotMatch(JSON.stringify([states, adapter.currentState()]), SECRETS);
});

test('useExistingLogin saves only the choice and readiness then uses that login', async t => {
  const { adapter, optionsSeen, states, baseDirectory } = loginAdapter(t, {
    acceptedLogins: ['app', 'github-cli'],
  });

  const state = await adapter.useExistingLogin('github-cli');

  const saved = readFileSync(choiceFile(baseDirectory), 'utf8');
  assert.deepEqual(JSON.parse(saved), { source: 'github-cli' });
  assert.doesNotMatch(saved, SECRETS);
  assert.equal(state.phase, 'ready');
  assert.equal(state.authentication, 'signed_in');
  assert.equal(state.loginSource, 'github-cli');
  assert.deepEqual(state.account, { label: 'cli-user', host: 'https://github.com' });
  assert.equal(states.at(-1).loginSource, 'github-cli');
  const readiness = optionsSeen.at(-1);
  assert.equal(readiness.gitHubToken, 'gh-secret');
  assert.equal(readiness.useLoggedInUser, false);
  assert.equal(readiness.env.GH_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(states), SECRETS);
});

test('a chosen login that disappears reports signed out without falling back', async t => {
  const baseDirectory = scratchDirectory(t);
  await saveLoginChoice(baseDirectory, 'environment');
  const { adapter, optionsSeen } = loginAdapter(t, {
    acceptedLogins: ['app', 'github-cli', 'environment'],
    environment: { PATH: 'C:\\tools' },
    ghOutput: null,
    baseDirectory,
    appAuth: { isAuthenticated: true, authType: 'user', login: 'app-user' },
  });

  const state = await adapter.check();

  assert.equal(state.authentication, 'signed_out');
  assert.match(state.message, /set to use your environment token, but it isn't available now/);
  assert.deepEqual(state.existingLogins, []);
  assert.equal(optionsSeen.length, 0);
  assert.equal(existsSync(choiceFile(baseDirectory)), true);
});

test('forgetExistingLogin clears the choice and publishes app readiness', async t => {
  const { adapter, baseDirectory, states } = loginAdapter(t, {
    acceptedLogins: ['app', 'environment'],
    appAuth: { isAuthenticated: true, authType: 'user', login: 'app-user' },
  });
  await adapter.useExistingLogin('environment');
  assert.equal(adapter.currentState().loginSource, 'environment');

  const state = await adapter.forgetExistingLogin();

  assert.equal(existsSync(choiceFile(baseDirectory)), false);
  assert.equal(state.loginSource, 'app');
  assert.deepEqual(state.account, { label: 'app-user' });
  assert.equal(states.at(-1).loginSource, 'app');
});

test('unknown and unaccepted login sources are rejected', async t => {
  assert.throws(
    () => new CopilotEngineAccountAdapter({ clientOptions: { baseDirectory: 'C:\\floe-home' }, acceptedLogins: ['app', 'keychain'] }),
    { code: 'invalid_login_source' },
  );
  const { adapter } = loginAdapter(t, { acceptedLogins: ['app', 'environment'] });
  await assert.rejects(adapter.useExistingLogin('keychain'), { code: 'invalid_login_source' });
  await assert.rejects(adapter.useExistingLogin('app'), { code: 'invalid_login_source' });
  await assert.rejects(adapter.useExistingLogin('github-cli'), { code: 'login_source_not_accepted' });
});

test('existing logins are unavailable with an external Copilot server connection', async t => {
  const connection = RuntimeConnection.forUri('localhost:3000');
  const { adapter, optionsSeen, spawnCalls } = loginAdapter(t, {
    acceptedLogins: ['app', 'github-cli'],
    connection,
  });

  const state = await adapter.check();

  assert.deepEqual(state.existingLogins, []);
  assert.match(state.existingLoginsUnavailable, /external Copilot server/);
  await assert.rejects(adapter.useExistingLogin('github-cli'), { code: 'existing_login_unavailable' });
  assert.equal(spawnCalls.length, 0);
  assert.equal('useLoggedInUser' in optionsSeen[0], false);
  assert.doesNotThrow(() => new CopilotClient(optionsSeen[0]));
});

test('runtime clients receive a freshly resolved token from the chosen login', async t => {
  const baseDirectory = scratchDirectory(t);
  await saveLoginChoice(baseDirectory, 'environment');
  let client;
  const runtime = new CopilotRuntime({
    clientFactory: options => {
      client = new FakeCopilotClient(options);
      client.authStatus = { isAuthenticated: true, authType: 'token', login: 'env-user', host: 'https://github.com' };
      return client;
    },
    clientOptions: { baseDirectory, env: { COPILOT_GITHUB_TOKEN: 'env-secret', FLOE_SAFE: 'kept' } },
    expectedAccount: { label: 'env-user', host: 'https://github.com' },
    timeoutMs: 100,
    quiesceTimeoutMs: 25,
  });
  try {
    const result = await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(result.report, { ok: true, summary: 'done' });
    assert.equal(client.options.gitHubToken, 'env-secret');
    assert.equal(client.options.useLoggedInUser, false);
    assert.equal(client.options.env.COPILOT_GITHUB_TOKEN, undefined);
    assert.equal(client.options.env.FLOE_SAFE, 'kept');
  } finally {
    await runtime.close();
  }
});

test('runtime refuses to start when the chosen login has no token', async t => {
  const baseDirectory = scratchDirectory(t);
  await saveLoginChoice(baseDirectory, 'environment');
  let created = 0;
  const runtime = new CopilotRuntime({
    clientFactory: options => { created += 1; return new FakeCopilotClient(options); },
    clientOptions: {
      baseDirectory,
      connection: RuntimeConnection.forStdio({ path: 'C:\\copilot.exe', env: { FLOE_SAFE: 'kept' } }),
    },
    expectedAccount: { label: 'env-user' },
    timeoutMs: 100,
  });
  try {
    await assert.rejects(runtime.start(), { code: 'copilot_login_unavailable' });
    assert.equal(created, 0);
  } finally {
    await runtime.close();
  }
});

const TOKEN_ONLY = {
  'gh-secret': { isAuthenticated: true, authType: 'token' },
};

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = {} } = responses.shift() ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

test('a token login without an SDK login name is identified through GitHub /user', async t => {
  const { fetch, calls } = fakeFetch([{ body: { login: 'cli-user' } }, { body: { login: 'cli-user' } }, { body: { login: 'cli-user' } }]);
  const { adapter, states, baseDirectory } = loginAdapter(t, {
    acceptedLogins: ['app', 'github-cli'],
    identities: TOKEN_ONLY,
    fetch,
  });

  const signedOut = await adapter.check();
  assert.deepEqual(signedOut.existingLogins, [{ source: 'github-cli', login: 'cli-user' }]);
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.deepEqual(calls[0].init.headers, {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer gh-secret',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const ready = await adapter.useExistingLogin('github-cli');
  assert.equal(ready.phase, 'ready');
  assert.deepEqual(ready.account, { label: 'cli-user' });
  assert.equal(ready.loginSource, 'github-cli');
  assert.doesNotMatch(readFileSync(choiceFile(baseDirectory), 'utf8'), SECRETS);
  assert.doesNotMatch(JSON.stringify(states), SECRETS);
});

test('a token GitHub /user does not confirm is not offered', async t => {
  for (const response of [{ status: 401, body: { message: 'Bad credentials' } }, { body: {} }]) {
    const { fetch } = fakeFetch([response, response]);
    const { adapter } = loginAdapter(t, {
      acceptedLogins: ['app', 'github-cli'],
      identities: TOKEN_ONLY,
      fetch,
    });
    const state = await adapter.check();
    assert.deepEqual(state.existingLogins, []);
    await assert.rejects(adapter.useExistingLogin('github-cli'), { code: 'existing_login_not_found' });
  }
  const failing = loginAdapter(t, {
    acceptedLogins: ['app', 'github-cli'],
    identities: TOKEN_ONLY,
    fetch: async () => { throw new Error('offline'); },
  });
  assert.deepEqual((await failing.adapter.check()).existingLogins, []);
});

test('GitHub REST base follows the Copilot host', () => {
  assert.equal(githubApiBase(undefined), 'https://api.github.com');
  assert.equal(githubApiBase('https://github.com'), 'https://api.github.com');
  assert.equal(githubApiBase('https://octo.ghe.com'), 'https://api.octo.ghe.com');
  assert.equal(githubApiBase('github.example.com'), 'https://github.example.com/api/v3');
});

test('runtime confirms a chosen token login through GitHub /user when the SDK omits it', async t => {
  const baseDirectory = scratchDirectory(t);
  await saveLoginChoice(baseDirectory, 'environment');
  const { fetch, calls } = fakeFetch([{ body: { login: 'env-user' } }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const runtime = new CopilotRuntime({
    clientFactory: options => {
      const client = new FakeCopilotClient(options);
      client.authStatus = { isAuthenticated: true, authType: 'token' };
      return client;
    },
    clientOptions: { baseDirectory, env: { COPILOT_GITHUB_TOKEN: 'env-secret' } },
    expectedAccount: { label: 'env-user' },
    timeoutMs: 100,
    quiesceTimeoutMs: 25,
  });
  try {
    const result = await runtime.run('worker', { prompt: 'hello', schema: SCHEMA }, 'C:\\work');
    assert.deepEqual(result.report, { ok: true, summary: 'done' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer env-secret');
  } finally {
    await runtime.close();
  }
});
