/**
 * @invariant Copilot readiness accepts only the vendor-managed user OAuth
 * identity; ambient process credentials and keytar-disabling overrides never
 * reach the SDK child. The session login RPC is experimental; provider/step
 * mappings stay here and unsupported answers are surfaced without guessing.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CopilotClient } from '@github/copilot-sdk';
import { RuntimeFault } from '../errors.mjs';

const CREDENTIAL_ENVIRONMENT_KEYS = new Set([
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_DISABLE_KEYTAR',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);
const PROCESS_GLOBAL_AUTH_TYPES = new Set(['env', 'token', 'api-key', 'gh-cli']);
const NOT_ENTITLED_CODES = new Set([
  'copilot_not_entitled',
  'no_copilot_subscription',
  'not_entitled',
  'subscription_required',
]);
const POLICY_BLOCKED_CODES = new Set([
  'copilot_policy_blocked',
  'organization_policy_blocked',
  'policy_blocked',
]);

const LOGIN_PROVIDER_KINDS = Object.freeze({
  github: 'githubDotCom',
  'github-enterprise-cloud': 'proxima',
  'microsoft-entra': 'entra',
});

const ACCOUNT_PROVIDER_KINDS = Object.freeze({
  githubDotCom: 'github',
  proxima: 'github-enterprise-cloud',
  entra: 'microsoft-entra',
  entraEmu: 'microsoft-entra',
  loki: 'microsoft-365',
});

const PROCESS_GLOBAL_AUTH_MESSAGES = Object.freeze({
  env: "Copilot isn't signed in for Floe. Floe found Copilot credentials in environment variables, but doesn't use them. Sign in to use Copilot here.",
  token: "Copilot isn't signed in for Floe. Floe found a process-level GitHub token, but doesn't use it as your Copilot account. Sign in to use Copilot here.",
  'api-key': "Copilot isn't signed in for Floe. Floe found an API key, but doesn't use it as your Copilot account. Sign in to use Copilot here.",
  'gh-cli': "Copilot isn't signed in for Floe. Floe found your GitHub CLI login, but doesn't use it. Sign in to use Copilot here.",
});

export function copilotChildEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !CREDENTIAL_ENVIRONMENT_KEYS.has(key.toUpperCase())),
  );
}

export function copilotEnvironmentForHome(environment, baseDirectory) {
  const withoutHome = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'COPILOT_HOME'),
  );
  return copilotChildEnvironment({ ...withoutHome, COPILOT_HOME: baseDirectory });
}

export function copilotConnectionForHome(connection, baseDirectory) {
  if (!connection || typeof connection !== 'object' || !connection.env) return connection;
  return {
    ...connection,
    env: copilotEnvironmentForHome(connection.env, baseDirectory),
  };
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code.toLowerCase() : '';
}

function accountOf(auth) {
  return auth.login
    ? { label: auth.login, ...(auth.host ? { host: auth.host } : {}) }
    : undefined;
}

function openSystemBrowser(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new RuntimeFault('invalid_sign_in_url', 'Copilot returned a non-HTTPS sign-in URL.', 502);
  }
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href]]
    : process.platform === 'darwin'
      ? ['open', [parsed.href]]
      : ['xdg-open', [parsed.href]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env: copilotChildEnvironment(process.env),
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export class CopilotEngineAccountAdapter extends EventEmitter {
  constructor({
    clientFactory = options => new CopilotClient(options),
    clientOptions = {},
    cliPath,
    environment = process.env,
    spawnProcess = spawn,
    openUrl = openSystemBrowser,
    now = () => new Date().toISOString(),
    operationId = () => randomUUID(),
  } = {}) {
    super();
    if (typeof clientOptions.baseDirectory !== 'string' || clientOptions.baseDirectory.trim().length === 0) {
      throw new TypeError('CopilotEngineAccountAdapter requires clientOptions.baseDirectory to share Floe-owned Copilot state.');
    }
    this.clientFactory = clientFactory;
    this.clientOptions = clientOptions;
    this.cliPath = cliPath;
    this.environment = environment;
    this.spawnProcess = spawnProcess;
    this.openUrl = openUrl;
    this.now = now;
    this.operationId = operationId;
    this.revision = 0;
    this.checking = null;
    this.operations = new Map();
    this.current = {
      engine: 'copilot',
      phase: 'checking',
      authentication: 'unknown',
      access: 'unknown',
      reachability: 'unknown',
      message: 'Checking Copilot.',
      checked_at: this.now(),
      revision: this.revision,
    };
  }

  currentState() {
    return { ...this.current, ...(this.current.account ? { account: { ...this.current.account } } : {}) };
  }

  async check() {
    if (this.checking) return this.checking;
    this.checking = this.#check();
    try {
      return await this.checking;
    } finally {
      this.checking = null;
    }
  }

  async #check() {
    this.#publishState({
      phase: 'checking',
      authentication: 'unknown',
      access: 'unknown',
      reachability: 'unknown',
      message: 'Checking Copilot.',
    });

    let client;
    try {
      client = await this.clientFactory(this.#sdkOptions());
      await client.start();
      await client.ping();
    } catch {
      await this.#stopClient(client);
      return this.#publishState({
        phase: 'unavailable',
        authentication: 'unknown',
        access: 'unknown',
        reachability: 'unreachable',
        action: 'retry',
        message: 'Copilot could not be reached.',
      });
    }

    try {
      let auth;
      try {
        auth = await client.getAuthStatus();
      } catch {
        return this.#publishState({
          phase: 'unavailable',
          authentication: 'unknown',
          access: 'unknown',
          reachability: 'reachable',
          action: 'retry',
          message: 'Copilot authentication could not be checked.',
        });
      }

      if (!auth?.isAuthenticated) {
        return this.#publishState({
          phase: 'action_required',
          authentication: 'signed_out',
          access: 'unknown',
          reachability: 'reachable',
          action: 'sign_in',
          message: 'Copilot is not signed in on this machine.',
        });
      }

      if (PROCESS_GLOBAL_AUTH_TYPES.has(auth.authType)) {
        return this.#publishState({
          phase: 'action_required',
          authentication: 'signed_out',
          access: 'unknown',
          reachability: 'reachable',
          action: 'sign_in',
          message: PROCESS_GLOBAL_AUTH_MESSAGES[auth.authType],
        });
      }

      const account = accountOf(auth);
      try {
        const models = await client.listModels();
        if (!Array.isArray(models) || models.length === 0) {
          return this.#publishState({
            phase: 'action_required',
            authentication: 'signed_in',
            access: 'unknown',
            reachability: 'reachable',
            account,
            action: 'retry',
            message: `Signed in${account ? ` as ${account.label}` : ''}, but Copilot access could not be confirmed.`,
          });
        }
        return this.#publishState({
          phase: 'ready',
          authentication: 'signed_in',
          access: 'entitled',
          reachability: 'reachable',
          account,
          message: `Copilot is ready${account ? ` for ${account.label}` : ''}.`,
        });
      } catch (error) {
        const code = errorCode(error);
        if (NOT_ENTITLED_CODES.has(code)) {
          return this.#publishState({
            phase: 'action_required',
            authentication: 'signed_in',
            access: 'not_entitled',
            reachability: 'reachable',
            account,
            action: 'check_subscription',
            message: `Signed in${account ? ` as ${account.label}` : ''}, but this account has no Copilot plan usable by the CLI.`,
          });
        }
        if (POLICY_BLOCKED_CODES.has(code)) {
          return this.#publishState({
            phase: 'action_required',
            authentication: 'signed_in',
            access: 'policy_blocked',
            reachability: 'reachable',
            account,
            action: 'contact_admin',
            message: `Signed in${account ? ` as ${account.label}` : ''}, but the organization has disabled Copilot CLI.`,
          });
        }
        return this.#publishState({
          phase: 'action_required',
          authentication: 'signed_in',
          access: 'unknown',
          reachability: 'reachable',
          account,
          action: 'retry',
          message: `Signed in${account ? ` as ${account.label}` : ''}, but Copilot access could not be confirmed.`,
        });
      }
    } finally {
      await this.#stopClient(client);
    }
  }

  async signIn(options = {}) {
    const { mode, provider = 'github' } = options;
    if (mode !== undefined && mode !== 'browser' && mode !== 'device') {
      throw new RuntimeFault('invalid_sign_in_mode', `Unsupported Copilot sign-in mode '${mode}'.`, 400);
    }
    if (!Object.hasOwn(LOGIN_PROVIDER_KINDS, provider)) {
      throw new RuntimeFault('invalid_sign_in_provider', `Unsupported sign-in provider '${provider}'.`, 400);
    }
    if (this.operations.size > 0) {
      throw new RuntimeFault('sign_in_in_progress', 'Copilot sign-in is already in progress.', 409);
    }

    if (mode === 'device') {
      if (provider !== 'github') {
        throw new RuntimeFault('invalid_sign_in_provider', 'The CLI device-code compatibility mode supports GitHub only.', 400);
      }
      return this.#startDeviceSignIn();
    }
    return this.#startSdkSignIn({
      provider,
      openBrowser: options.openBrowser ?? true,
    });
  }

  async #startDeviceSignIn() {
    if (!this.cliPath) {
      throw new RuntimeFault('copilot_cli_unavailable', 'The Copilot CLI path is required for device-code compatibility mode.', 503);
    }

    const id = this.operationId();
    const operation = { id, provider: 'github', mode: 'device', child: null, cancellationRequested: false, finished: false };
    this.operations.set(id, operation);
    this.#publishSignIn(operation, 'starting', 'Starting GitHub sign-in.');
    if (operation.cancellationRequested) {
      void this.#finishDeviceSignIn(operation, 'cancelled');
      return { id };
    }

    const loginArgs = ['login', '--device-code'];
    const isJavaScript = /\.[cm]?js$/i.test(this.cliPath);
    const command = isJavaScript ? process.execPath : this.cliPath;
    const args = isJavaScript ? [this.cliPath, ...loginArgs] : loginArgs;

    try {
      operation.child = this.spawnProcess(command, args, {
        env: copilotEnvironmentForHome({
          ...this.environment,
          ...this.clientOptions.env,
        }, this.clientOptions.baseDirectory),
        stdio: 'inherit',
        windowsHide: true,
      });
    } catch {
      void this.#finishDeviceSignIn(operation, 'failed');
      return { id };
    }

    operation.child.once('spawn', () => {
      if (!operation.finished) {
        this.#publishSignIn(
          operation,
          'waiting_for_person',
          "Finish GitHub device sign-in with the code shown for this sign-in. If no code is visible, cancel this sign-in and try again.",
        );
      }
    });
    operation.child.once('error', () => void this.#finishDeviceSignIn(operation, 'failed'));
    operation.child.once('exit', code => {
      const outcome = operation.cancellationRequested ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      void this.#finishDeviceSignIn(operation, outcome);
    });
    return { id };
  }

  async #startSdkSignIn({ provider, openBrowser }) {
    const id = this.operationId();
    const operation = {
      id,
      provider,
      mode: 'sdk',
      client: null,
      session: null,
      flowId: null,
      pendingAction: null,
      advancing: false,
      cancellationRequested: false,
      finished: false,
    };
    operation.cancelled = new Promise(resolve => {
      operation.resolveCancellation = resolve;
    });
    this.operations.set(id, operation);
    this.#publishSignIn(operation, 'starting', 'Starting sign-in.');
    if (operation.finished) return { id };

    try {
      const client = await this.clientFactory(this.#sdkOptions());
      if (operation.finished) {
        await this.#stopClient(client);
        return { id };
      }
      operation.client = client;
      await operation.client.start();
      if (operation.finished) return { id };
      operation.session = await operation.client.createSession({ enableExperimentalMode: true });
      if (operation.finished) {
        await operation.session?.disconnect?.();
        return { id };
      }
      const begun = await operation.session.rpc.accounts.login.begin({ kind: LOGIN_PROVIDER_KINDS[provider] });
      if (typeof begun?.flowId !== 'string' || !begun.step) {
        throw new Error('Copilot returned an invalid sign-in flow.');
      }
      operation.flowId = begun.flowId;
      await this.#handleSdkStep(operation, begun.step, openBrowser);
    } catch {
      await this.#finishSdkSignIn(operation, 'failed');
    }
    return { id };
  }

  async continueSignIn(id, answer) {
    const operation = this.operations.get(id);
    if (!operation || operation.finished) {
      throw new RuntimeFault('sign_in_not_found', `Copilot sign-in operation '${id}' is not active.`, 404);
    }
    if (operation.mode !== 'sdk') {
      throw new RuntimeFault('sign_in_answer_unsupported', 'The CLI device-code flow does not accept app-provided answers.', 409);
    }
    if (operation.advancing) {
      throw new RuntimeFault('sign_in_in_progress', 'Copilot sign-in is waiting for the current response.', 409);
    }

    const action = operation.pendingAction;
    let input;
    if (action?.kind === 'open_url' || action?.kind === 'needs_interaction' || action?.kind === 'awaiting') {
      if (answer?.kind !== 'continue') {
        throw new RuntimeFault('invalid_sign_in_answer', 'This sign-in step requires a continue answer.', 400);
      }
    } else if (action?.kind === 'input_required') {
      if (answer?.kind !== 'input' || typeof answer.value !== 'string') {
        throw new RuntimeFault('invalid_sign_in_answer', 'This sign-in step requires a text input answer.', 400);
      }
      input = answer.value;
    } else if (action?.kind === 'account_selection') {
      if (answer?.kind !== 'select_account' || !action.accounts.some(account => account.selectionId === answer.selectionId)) {
        throw new RuntimeFault('invalid_sign_in_answer', 'Choose one of the accounts returned for this sign-in.', 400);
      }
      input = answer.selectionId;
    } else if (action?.kind === 'plaintext_consent') {
      if (answer?.kind !== 'plaintext_consent' || typeof answer.accepted !== 'boolean') {
        throw new RuntimeFault('invalid_sign_in_answer', 'This sign-in step requires a plaintext-consent answer.', 400);
      }
      throw new RuntimeFault(
        'copilot_login_action_unsupported',
        'This Copilot SDK version exposes plaintext consent but does not define a safe answer format.',
        501,
      );
    } else {
      throw new RuntimeFault('sign_in_answer_unsupported', 'The current Copilot sign-in step cannot accept an answer.', 409);
    }

    operation.pendingAction = null;
    return this.#advanceSdkSignIn(operation, input);
  }

  async cancelSignIn(id) {
    const operation = this.operations.get(id);
    if (!operation || operation.finished) {
      throw new RuntimeFault('sign_in_not_found', `Copilot sign-in operation '${id}' is not active.`, 404);
    }
    operation.cancellationRequested = true;
    if (operation.mode === 'device') {
      operation.child?.kill();
      return;
    }
    operation.resolveCancellation?.();
    await this.#finishSdkSignIn(operation, 'cancelled');
  }

  async close() {
    await Promise.all([...this.operations.values()].map(operation => this.cancelSignIn(operation.id).catch(() => {})));
  }

  async #advanceSdkSignIn(operation, input) {
    if (operation.finished || operation.advancing) return;
    operation.advancing = true;
    try {
      const step = await Promise.race([
        operation.session.rpc.accounts.login.advance({
          flowId: operation.flowId,
          ...(input !== undefined ? { input } : {}),
        }),
        operation.cancelled.then(() => null),
      ]);
      if (step === null || operation.finished) return;
      if (!operation.finished) await this.#handleSdkStep(operation, step, false);
    } catch {
      if (!operation.finished) {
        await this.#finishSdkSignIn(operation, operation.cancellationRequested ? 'cancelled' : 'failed');
      }
    } finally {
      operation.advancing = false;
    }
  }

  async #handleSdkStep(operation, step, openBrowser) {
    if (operation.finished || operation.cancellationRequested) return;
    switch (step?.kind) {
      case 'open-url': {
        let url;
        try {
          const parsed = new URL(step.url);
          if (parsed.protocol !== 'https:') throw new Error('Not HTTPS');
          url = parsed.href;
        } catch {
          await this.#finishSdkSignIn(operation, 'failed');
          return;
        }
        operation.pendingAction = { kind: 'open_url', url };
        this.#publishSignIn(operation, 'waiting_for_person', 'Open the sign-in page to continue.', operation.pendingAction);
        if (openBrowser) {
          try {
            await this.openUrl(url);
            void this.#advanceSdkSignIn(operation);
          } catch {
            this.#publishSignIn(
              operation,
              'waiting_for_person',
              'Floe could not open the sign-in page. Open the URL to continue.',
              operation.pendingAction,
            );
          }
        }
        return;
      }
      case 'input-required':
        operation.pendingAction = { kind: 'input_required', prompt: step.prompt };
        this.#publishSignIn(operation, 'awaiting_input', 'Copilot needs information to continue sign-in.', operation.pendingAction);
        return;
      case 'needs-interaction':
        operation.pendingAction = { kind: 'needs_interaction' };
        this.#publishSignIn(operation, 'needs_interaction', 'Complete the sign-in step in the provider window, then continue.', operation.pendingAction);
        return;
      case 'awaiting':
        operation.pendingAction = { kind: 'awaiting' };
        this.#publishSignIn(operation, 'waiting_for_person', 'Sign-in is waiting for your confirmation.', operation.pendingAction);
        return;
      case 'completed': {
        const result = step.result;
        if (result?.status === 'completed') {
          await this.#finishSdkSignIn(operation, 'completed');
        } else if (result?.status === 'needs-account-selection') {
          const accounts = Array.isArray(result.accounts) ? result.accounts.map(account => ({
            selectionId: account.selectionId,
            login: account.login,
            host: account.host,
            provider: ACCOUNT_PROVIDER_KINDS[account.kind] || 'other',
          })) : [];
          operation.pendingAction = { kind: 'account_selection', accounts };
          this.#publishSignIn(
            operation,
            'needs_account_selection',
            'Choose an account to finish sign-in.',
            operation.pendingAction,
          );
        } else if (result?.status === 'needs-plaintext-consent') {
          operation.pendingAction = { kind: 'plaintext_consent' };
          this.#publishSignIn(
            operation,
            'needs_plaintext_consent',
            'Copilot requires consent to store credentials in plaintext.',
            operation.pendingAction,
          );
        } else if (result?.status === 'declined') {
          await this.#finishSdkSignIn(operation, 'declined');
        } else {
          await this.#finishSdkSignIn(operation, 'failed');
        }
        return;
      }
      case 'error':
      default:
        await this.#finishSdkSignIn(operation, 'failed');
    }
  }

  #sdkOptions() {
    const { gitHubToken: _ignoredToken, connection, env: optionEnvironment, ...options } = this.clientOptions;
    const environment = copilotEnvironmentForHome(
      { ...this.environment, ...optionEnvironment },
      this.clientOptions.baseDirectory,
    );
    return {
      ...options,
      ...(connection ? { connection: copilotConnectionForHome(connection, this.clientOptions.baseDirectory) } : {}),
      mode: 'copilot-cli',
      env: environment,
      useLoggedInUser: true,
    };
  }

  async #stopClient(client) {
    if (!client?.stop) return;
    try {
      await client.stop();
    } catch {
      this.emit('diagnostic', 'Copilot account/sign-in client could not be stopped cleanly.');
    }
  }

  async #finishDeviceSignIn(operation, outcome) {
    if (operation.finished) return;
    operation.finished = true;
    if (this.checking) await this.checking;
    const state = await this.check();

    if (outcome === 'cancelled') {
      this.#publishSignIn(operation, 'cancelled', 'GitHub sign-in was cancelled.');
    } else if (outcome === 'completed' && state.authentication === 'signed_in') {
      this.#publishSignIn(operation, 'succeeded', 'Signed in to GitHub Copilot.');
    } else {
      this.#publishSignIn(operation, 'failed', 'GitHub sign-in did not complete.');
    }
    this.operations.delete(operation.id);
  }

  async #finishSdkSignIn(operation, outcome) {
    if (operation.finished) return;
    operation.finished = true;
    operation.resolveCancellation?.();
    if (outcome === 'cancelled' && operation.session && operation.flowId) {
      try {
        await operation.session.rpc.accounts.login.cancel({ flowId: operation.flowId });
      } catch {
        // Session teardown below still releases the flow if cancellation is already terminal.
      }
    }
    try {
      await operation.session?.disconnect?.();
    } catch {
      this.emit('diagnostic', 'Copilot sign-in session could not be disconnected cleanly.');
    }
    await this.#stopClient(operation.client);
    if (this.checking) await this.checking;
    const state = await this.check();
    if (outcome === 'cancelled') {
      this.#publishSignIn(operation, 'cancelled', 'Sign-in was cancelled.');
    } else if (outcome === 'declined') {
      this.#publishSignIn(operation, 'declined', 'Sign-in was declined.');
    } else if (outcome === 'completed' && state.authentication === 'signed_in') {
      this.#publishSignIn(operation, 'succeeded', 'Signed in to GitHub Copilot.');
    } else {
      this.#publishSignIn(operation, 'failed', 'Sign-in did not complete.');
    }
    this.operations.delete(operation.id);
  }

  #publishState(state) {
    this.current = {
      engine: 'copilot',
      ...state,
      checked_at: this.now(),
      revision: ++this.revision,
    };
    const published = this.currentState();
    this.emit('state', published);
    return published;
  }

  #publishSignIn(operation, status, message, action) {
    this.emit('sign_in', {
      operationId: operation.id,
      engine: 'copilot',
      provider: operation.provider,
      status,
      message,
      ...(action ? { action } : {}),
    });
  }
}
