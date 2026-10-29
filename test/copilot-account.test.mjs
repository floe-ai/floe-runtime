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
  copilot_disable_keytar: '1',
  gh_token: 'gh-secret',
  GITHUB_TOKEN: 'github-secret',
  COPILOT_HOME: 'C:\\wrong-home',
  SAFE_VALUE: 'kept',
};

class FakeAccountClient {
  constructor({ auth, models, modelError, startError, events, loginSession }) {
    this.auth = auth;
    this.models = models;
    this.modelError = modelError;
    this.startError = startError;
    this.events = events;
    this.loginSession = loginSession;
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

  async createSession(options) {
    this.events.push(['createSession', options]);
    return this.loginSession;
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
  cliPath,
  spawnProcess,
  clientOptions,
  openUrl,
} = {}) {
  const optionsSeen = [];
  let clientIndex = 0;
  const adapter = new CopilotEngineAccountAdapter({
    clientFactory: options => {
      optionsSeen.push(options);
      return new FakeAccountClient(clients[clientIndex++]);
    },
    clientOptions: { baseDirectory: 'C:\\floe-home', ...clientOptions },
    cliPath,
    environment: PARENT_ENVIRONMENT,
    spawnProcess,
    openUrl,
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
    clientOptions: {
      connection: { env: { COPILOT_HOME: 'C:\\wrong-connection-home', GH_TOKEN: 'ignored', SAFE_CONNECTION: 'kept' } },
    },
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
  assert.equal(optionsSeen[0].env.COPILOT_HOME, 'C:\\floe-home');
  assert.equal(optionsSeen[0].connection.env.COPILOT_HOME, 'C:\\floe-home');
  assert.equal(optionsSeen[0].connection.env.GH_TOKEN, undefined);
  assert.equal(optionsSeen[0].connection.env.SAFE_CONNECTION, 'kept');
  assert.equal(optionsSeen[0].env.COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(optionsSeen[0].env.GH_TOKEN, undefined);
  assert.equal(optionsSeen[0].env.gh_token, undefined);
  assert.equal(optionsSeen[0].env.GITHUB_TOKEN, undefined);
  assert.equal(optionsSeen[0].env.copilot_disable_keytar, undefined);
  assert.equal(optionsSeen[0].gitHubToken, undefined);
  assert.equal(optionsSeen[0].useLoggedInUser, true);
  assert.equal(optionsSeen[0].mode, 'copilot-cli');
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

test('Copilot sign-in lets the app handle the URL when browser opening is disabled', async () => {
  const calls = [];
  const opened = [];
  const loginEvents = [];
  const session = {
    rpc: { accounts: { login: {
      begin: async params => {
        calls.push(['begin', params]);
        return { flowId: 'flow-1', step: { kind: 'open-url', url: 'https://github.com/login/device' } };
      },
      advance: async params => {
        calls.push(['advance', params]);
        return { kind: 'completed', result: { status: 'completed', login: 'octocat', token: 'not-for-apps' } };
      },
      cancel: async params => calls.push(['cancel', params]),
    } } },
    disconnect: async () => loginEvents.push('disconnect'),
  };
  const signedOut = { auth: { isAuthenticated: false }, models: [], events: [] };
  const signedIn = { auth: { isAuthenticated: true, authType: 'user', login: 'octocat' }, models: [{ id: 'gpt-5-mini' }], events: [] };
  const loginClient = new FakeAccountClient({ events: loginEvents, loginSession: session });
  const progress = [];
  const { adapter, optionsSeen } = accountAdapter({
    clients: [signedOut, loginClient, signedIn],
    openUrl: async url => opened.push(url),
  });
  adapter.on('sign_in', event => progress.push(event));
  const succeeded = nextEvent(adapter, 'sign_in', event => event.status === 'succeeded');

  assert.equal((await adapter.check()).authentication, 'signed_out');
  const { id } = await adapter.signIn({ openBrowser: false });
  assert.equal(progress[0].status, 'starting');
  assert.equal(progress[1].status, 'waiting_for_person');
  assert.deepEqual(progress[1].action, { kind: 'open_url', url: 'https://github.com/login/device' });
  assert.deepEqual(calls, [['begin', { kind: 'githubDotCom' }]]);
  await adapter.continueSignIn(id, { kind: 'continue' });
  await succeeded;

  assert.deepEqual(calls, [
    ['begin', { kind: 'githubDotCom' }],
    ['advance', { flowId: 'flow-1' }],
  ]);
  assert.deepEqual(loginEvents[1], ['createSession', { enableExperimentalMode: true }]);
  assert.ok(loginEvents.includes('disconnect'));
  assert.equal(loginEvents.at(-1), 'stop');
  assert.equal(optionsSeen.length, 3);
  assert.ok(optionsSeen.every(options => options.baseDirectory === 'C:\\floe-home'));
  assert.equal(adapter.currentState().phase, 'ready');
  assert.deepEqual(opened, []);
  assert.doesNotMatch(JSON.stringify(progress), /not-for-apps|token/);
});

test('Copilot sign-in opens the returned URL by default and advances without polling', async () => {
  const calls = [];
  const opened = [];
  const session = {
    rpc: { accounts: { login: {
      begin: async () => ({ flowId: 'flow-1', step: { kind: 'open-url', url: 'https://github.com/login/oauth' } }),
      advance: async params => {
        calls.push(params);
        return { kind: 'completed', result: { status: 'completed' } };
      },
      cancel: async () => {},
    } } },
    disconnect: async () => {},
  };
  const signedOut = { auth: { isAuthenticated: false }, models: [], events: [] };
  const loginClient = new FakeAccountClient({ loginSession: session, events: [] });
  const signedIn = { auth: { isAuthenticated: true, authType: 'user', login: 'octocat' }, models: [{ id: 'model' }], events: [] };
  const { adapter } = accountAdapter({
    clients: [loginClient, signedIn],
    openUrl: async url => opened.push(url),
  });
  const complete = nextEvent(adapter, 'sign_in', event => event.status === 'succeeded');
  await adapter.signIn();
  await complete;

  assert.deepEqual(opened, ['https://github.com/login/oauth']);
  assert.deepEqual(calls, [{ flowId: 'flow-1' }]);
});

test('Copilot sign-in surfaces input, account-selection, and consent requirements explicitly', async () => {
  const calls = [];
  let step = { kind: 'input-required', prompt: 'Enter the enterprise host' };
  const session = {
    rpc: { accounts: { login: {
      begin: async params => {
        calls.push(['begin', params]);
        return { flowId: 'flow-1', step };
      },
      advance: async params => {
        calls.push(['advance', params]);
        if (params.input === 'enterprise.example') {
          return {
            kind: 'completed',
            result: {
              status: 'needs-account-selection',
              accounts: [{ selectionId: 'choice-1', login: 'octocat', host: 'https://enterprise.example', kind: 'proxima' }],
            },
          };
        }
        return { kind: 'completed', result: { status: 'needs-plaintext-consent' } };
      },
      cancel: async () => {},
    } } },
    disconnect: async () => {},
  };
  const signedOut = { auth: { isAuthenticated: false }, models: [], events: [] };
  const loginClient = new FakeAccountClient({ loginSession: session, events: [] });
  const { adapter } = accountAdapter({ clients: [loginClient, signedOut] });
  const progress = [];
  adapter.on('sign_in', event => progress.push(event));

  const { id } = await adapter.signIn({ provider: 'github-enterprise-cloud' });
  assert.deepEqual(progress.at(-1).action, { kind: 'input_required', prompt: 'Enter the enterprise host' });
  await adapter.continueSignIn(id, { kind: 'input', value: 'enterprise.example' });
  assert.equal(progress.at(-1).status, 'needs_account_selection');
  assert.deepEqual(progress.at(-1).action, {
    kind: 'account_selection',
    accounts: [{
      selectionId: 'choice-1',
      login: 'octocat',
      host: 'https://enterprise.example',
      provider: 'github-enterprise-cloud',
    }],
  });
  await adapter.continueSignIn(id, { kind: 'select_account', selectionId: 'choice-1' });
  assert.equal(progress.at(-1).status, 'needs_plaintext_consent');
  assert.deepEqual(progress.at(-1).action, { kind: 'plaintext_consent' });
  await assert.rejects(
    adapter.continueSignIn(id, { kind: 'plaintext_consent', accepted: true }),
    { code: 'copilot_login_action_unsupported' },
  );
  assert.deepEqual(calls, [
    ['begin', { kind: 'proxima' }],
    ['advance', { flowId: 'flow-1', input: 'enterprise.example' }],
    ['advance', { flowId: 'flow-1', input: 'choice-1' }],
  ]);
  await adapter.cancelSignIn(id);
});

test('Copilot device sign-in offers a retry without asking the person to run a command', async () => {
  const child = new FakeLoginProcess();
  const spawnCalls = [];
  const { adapter } = accountAdapter({
    cliPath: 'C:\\floe\\copilot-cli.js',
    clients: [
      { auth: { isAuthenticated: false }, models: [], events: [] },
      { auth: { isAuthenticated: false }, models: [], events: [] },
    ],
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
  assert.equal(spawnCalls[0][2].env.COPILOT_HOME, 'C:\\floe-home');
  assert.equal(spawnCalls[0][2].env.COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(
    event.message,
    "Finish GitHub device sign-in with the code shown for this sign-in. If no code is visible, cancel this sign-in and try again.",
  );
  await adapter.cancelSignIn('signin-1');
});

test('Copilot SDK sign-in cancellation cancels its flow and releases its session and client', async () => {
  const events = [];
  const calls = [];
  const session = {
    rpc: { accounts: { login: {
      begin: async params => {
        calls.push(['begin', params]);
        return { flowId: 'flow-1', step: { kind: 'needs-interaction' } };
      },
      advance: async () => new Promise(() => {}),
      cancel: async params => calls.push(['cancel', params]),
    } } },
    disconnect: async () => events.push('disconnect'),
  };
  const signedOut = { auth: { isAuthenticated: false }, models: [], events: [] };
  const loginClient = new FakeAccountClient({ loginSession: session, events });
  loginClient.stop = async () => events.push('stop');
  const { adapter } = accountAdapter({ clients: [loginClient, signedOut, signedOut] });
  const progress = [];
  adapter.on('sign_in', event => progress.push(event));
  const cancelled = nextEvent(adapter, 'sign_in', event => event.status === 'cancelled');

  const { id } = await adapter.signIn({ provider: 'microsoft-entra' });
  assert.equal(progress.at(-1).status, 'needs_interaction');
  assert.deepEqual(progress.at(-1).action, { kind: 'needs_interaction' });
  const advancing = adapter.continueSignIn(id, { kind: 'continue' });
  await adapter.cancelSignIn(id);
  await advancing;
  await cancelled;
  assert.deepEqual(calls, [
    ['begin', { kind: 'entra' }],
    ['cancel', { flowId: 'flow-1' }],
  ]);
  assert.deepEqual(events.slice(-2), ['disconnect', 'stop']);
});

test('Copilot sign-in cancellation stops the CLI and refreshes readiness', async () => {
  const child = new FakeLoginProcess();
  const { adapter } = accountAdapter({
    cliPath: 'C:\\floe\\copilot-cli.js',
    clients: [
      { auth: { isAuthenticated: false }, models: [], events: [] },
      { auth: { isAuthenticated: false }, models: [], events: [] },
    ],
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
    cliPath: 'C:\\floe\\copilot-cli.js',
    clients: [
      { auth: { isAuthenticated: false }, models: [], events: [] },
      { auth: { isAuthenticated: false }, models: [], events: [] },
    ],
    spawnProcess: () => child,
  });
  const failed = nextEvent(adapter, 'sign_in', event => event.status === 'failed');

  await adapter.signIn({ mode: 'device' });
  child.emit('exit', 1, null);
  const event = await failed;

  assert.equal(event.message, 'GitHub sign-in did not complete.');
  assert.equal(adapter.currentState().authentication, 'signed_out');
});

test('credential environment filtering is case-insensitive and preserves unrelated values', () => {
  assert.deepEqual(copilotChildEnvironment(PARENT_ENVIRONMENT), {
    PATH: 'C:\\tools',
    COPILOT_HOME: 'C:\\wrong-home',
    SAFE_VALUE: 'kept',
  });
});
