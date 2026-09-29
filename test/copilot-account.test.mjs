import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopilotEngineAccountAdapter,
  copilotChildEnvironment,
} from '../src/adapters/copilot.mjs';

const PARENT_ENVIRONMENT = {
  PATH: 'C:\\tools',
  COPILOT_GITHUB_TOKEN: 'copilot-secret',
  gh_token: 'gh-secret',
  GITHUB_TOKEN: 'github-secret',
  SAFE_VALUE: 'kept',
};

class FakeAccountClient {
  constructor({ auth, models, modelError, startError, events }) {
    this.auth = auth;
    this.models = models;
    this.modelError = modelError;
    this.startError = startError;
    this.events = events;
  }

  async start() {
    this.events.push('start');
    if (this.startError) throw this.startError;
  }

  async ping() {
    this.events.push('ping');
  }

  async getAuthStatus() {
    this.events.push('auth');
    return this.auth;
  }

  async listModels() {
    this.events.push('models');
    if (this.modelError) throw this.modelError;
    return this.models;
  }

  async stop() {
    this.events.push('stop');
  }
}

class FakeLoginProcess extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

function nextEvent(emitter, name, predicate = () => true) {
  return new Promise(resolve => {
    const listener = event => {
      if (!predicate(event)) return;
      emitter.off(name, listener);
      resolve(event);
    };
    emitter.on(name, listener);
  });
}

function accountAdapter({
  clients,
  cliPath = 'C:\\floe\\node_modules\\@github\\copilot\\index.js',
  spawnProcess,
  clientOptions,
} = {}) {
  const optionsSeen = [];
  let clientIndex = 0;
  const adapter = new CopilotEngineAccountAdapter({
    clientFactory: options => {
      optionsSeen.push(options);
      return new FakeAccountClient(clients[clientIndex++]);
    },
    clientOptions,
    cliPath,
    environment: PARENT_ENVIRONMENT,
    spawnProcess,
    now: () => '2026-09-29T00:00:00.000Z',
    operationId: () => 'signin-1',
  });
  return { adapter, optionsSeen };
}

test('Copilot account check reports ready and strips parent credentials from the SDK child', async () => {
  const events = [];
  const { adapter, optionsSeen } = accountAdapter({
    clients: [{
      auth: { isAuthenticated: true, authType: 'user', login: 'octocat', host: 'https://github.com' },
      models: [{ id: 'gpt-5-mini' }],
      events,
    }],
  });
  const states = [];
  adapter.on('state', state => states.push(state));

  const state = await adapter.check();

  assert.equal(state.phase, 'ready');
  assert.equal(state.authentication, 'signed_in');
  assert.equal(state.access, 'entitled');
  assert.deepEqual(state.account, { label: 'octocat', host: 'https://github.com' });
  assert.deepEqual(events, ['start', 'ping', 'auth', 'models', 'stop']);
  assert.equal(states[0].phase, 'checking');
  assert.equal(states.at(-1).phase, 'ready');
  assert.equal(optionsSeen[0].env.SAFE_VALUE, 'kept');
  assert.equal(optionsSeen[0].env.COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(optionsSeen[0].env.GH_TOKEN, undefined);
  assert.equal(optionsSeen[0].env.gh_token, undefined);
  assert.equal(optionsSeen[0].env.GITHUB_TOKEN, undefined);
  assert.equal(optionsSeen[0].gitHubToken, undefined);
  assert.equal(optionsSeen[0].useLoggedInUser, true);
});

test('Copilot account check distinguishes signed out, entitlement, policy, and reachability', async t => {
  const cases = [
    {
      name: 'signed out',
      client: { auth: { isAuthenticated: false }, models: [], events: [] },
      expected: { phase: 'action_required', authentication: 'signed_out', access: 'unknown', action: 'sign_in' },
    },
    {
      name: 'not entitled',
      client: {
        auth: { isAuthenticated: true, authType: 'user', login: 'octocat' },
        modelError: Object.assign(new Error('vendor detail'), { code: 'not_entitled' }),
        events: [],
      },
      expected: { phase: 'action_required', authentication: 'signed_in', access: 'not_entitled', action: 'check_subscription' },
    },
    {
      name: 'policy blocked',
      client: {
        auth: { isAuthenticated: true, authType: 'user', login: 'octocat' },
        modelError: Object.assign(new Error('vendor detail'), { code: 'policy_blocked' }),
        events: [],
      },
      expected: { phase: 'action_required', authentication: 'signed_in', access: 'policy_blocked', action: 'contact_admin' },
    },
    {
      name: 'runtime unreachable',
      client: { auth: null, models: [], startError: new Error('offline'), events: [] },
      expected: { phase: 'unavailable', authentication: 'unknown', access: 'unknown', reachability: 'unreachable', action: 'retry' },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { adapter } = accountAdapter({ clients: [entry.client] });
      const state = await adapter.check();
      assert.deepEqual(state, { ...state, ...entry.expected });
      assert.doesNotMatch(state.message, /vendor detail|offline/);
    });
  }
});

test('Copilot account check rejects process-global authentication sources', async () => {
  const cases = {
    env: "Copilot isn't signed in for Floe. Floe found Copilot credentials in environment variables, but doesn't use them. Sign in to use Copilot here.",
    token: "Copilot isn't signed in for Floe. Floe found a process-level GitHub token, but doesn't use it as your Copilot account. Sign in to use Copilot here.",
    'api-key': "Copilot isn't signed in for Floe. Floe found an API key, but doesn't use it as your Copilot account. Sign in to use Copilot here.",
    'gh-cli': "Copilot isn't signed in for Floe. Floe found your GitHub CLI login, but doesn't use it. Sign in to use Copilot here.",
  };
  for (const [authType, message] of Object.entries(cases)) {
    const events = [];
    const { adapter } = accountAdapter({
      clients: [{ auth: { isAuthenticated: true, authType, login: 'wrong-account' }, models: [{ id: 'model' }], events }],
    });
    const state = await adapter.check();
    assert.equal(state.authentication, 'signed_out');
    assert.equal(state.action, 'sign_in');
    assert.equal(state.message, message);
    assert.deepEqual(events, ['start', 'ping', 'auth', 'stop']);
  }
});

test('Copilot sign-in launches the official CLI hidden and rechecks with a fresh SDK client', async () => {
  const child = new FakeLoginProcess();
  const spawnCalls = [];
  const progress = [];
  const { adapter, optionsSeen } = accountAdapter({
    clients: [
      { auth: { isAuthenticated: false }, models: [], events: [] },
      {
        auth: { isAuthenticated: true, authType: 'user', login: 'octocat' },
        models: [{ id: 'gpt-5-mini' }],
        events: [],
      },
    ],
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
  });
  adapter.on('sign_in', event => progress.push(event));
  const succeeded = nextEvent(adapter, 'sign_in', event => event.status === 'succeeded');

  assert.equal((await adapter.check()).authentication, 'signed_out');
  const handle = await adapter.signIn({ mode: 'browser' });
  child.emit('spawn');
  child.emit('exit', 0, null);
  await succeeded;

  assert.deepEqual(handle, { id: 'signin-1' });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], process.execPath);
  assert.deepEqual(spawnCalls[0][1].slice(-2), ['login', '--web-flow']);
  assert.equal(spawnCalls[0][2].env.COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(spawnCalls[0][2].env.gh_token, undefined);
  assert.equal(spawnCalls[0][2].windowsHide, true);
  assert.equal(spawnCalls[0][2].stdio, 'inherit');
  assert.deepEqual(progress.map(event => event.status), ['starting', 'waiting_for_person', 'succeeded']);
  assert.equal(
    progress[1].message,
    "A browser should open for GitHub sign-in. If it doesn't, cancel this sign-in and try again.",
  );
  assert.equal(optionsSeen.length, 2);
  assert.equal(adapter.currentState().phase, 'ready');
});

test('Copilot device sign-in offers a retry without asking the person to run a command', async () => {
  const child = new FakeLoginProcess();
  const spawnCalls = [];
  const { adapter } = accountAdapter({
    clients: [{ auth: { isAuthenticated: false }, models: [], events: [] }],
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
  });
  const waiting = nextEvent(adapter, 'sign_in', event => event.status === 'waiting_for_person');

  await adapter.signIn({ mode: 'device' });
  child.emit('spawn');
  const event = await waiting;

  assert.deepEqual(spawnCalls[0][1].slice(-2), ['login', '--device-code']);
  assert.equal(spawnCalls[0][2].windowsHide, true);
  assert.equal(spawnCalls[0][2].stdio, 'inherit');
  assert.equal(
    event.message,
    "Finish GitHub device sign-in with the code shown for this sign-in. If no code is visible, cancel this sign-in and try again.",
  );
  await adapter.cancelSignIn('signin-1');
});

test('Copilot sign-in cancellation stops the CLI and refreshes readiness', async () => {
  const child = new FakeLoginProcess();
  const { adapter } = accountAdapter({
    clients: [{ auth: { isAuthenticated: false }, models: [], events: [] }],
    spawnProcess: () => child,
  });
  const cancelled = nextEvent(adapter, 'sign_in', event => event.status === 'cancelled');

  const { id } = await adapter.signIn({ mode: 'device' });
  await adapter.cancelSignIn(id);
  await cancelled;

  assert.equal(child.killed, true);
  assert.equal(adapter.currentState().authentication, 'signed_out');
});

test('Copilot sign-in reports a failed vendor process and refreshes readiness', async () => {
  const child = new FakeLoginProcess();
  const { adapter } = accountAdapter({
    clients: [{ auth: { isAuthenticated: false }, models: [], events: [] }],
    spawnProcess: () => child,
  });
  const failed = nextEvent(adapter, 'sign_in', event => event.status === 'failed');

  await adapter.signIn();
  child.emit('exit', 1, null);
  const event = await failed;

  assert.equal(event.message, 'GitHub sign-in did not complete.');
  assert.equal(adapter.currentState().authentication, 'signed_out');
});

test('credential environment filtering is case-insensitive and preserves unrelated values', () => {
  assert.deepEqual(copilotChildEnvironment(PARENT_ENVIRONMENT), {
    PATH: 'C:\\tools',
    SAFE_VALUE: 'kept',
  });
});
