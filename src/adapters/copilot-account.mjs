import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CopilotClient } from '@github/copilot-sdk';
import { RuntimeFault } from '../errors.mjs';

const CREDENTIAL_ENVIRONMENT_KEYS = new Set([
  'COPILOT_GITHUB_TOKEN',
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

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code.toLowerCase() : '';
}

function accountOf(auth) {
  return auth.login
    ? { label: auth.login, ...(auth.host ? { host: auth.host } : {}) }
    : undefined;
}

export class CopilotEngineAccountAdapter extends EventEmitter {
  constructor({
    clientFactory = options => new CopilotClient(options),
    clientOptions = {},
    cliPath,
    environment = process.env,
    spawnProcess = spawn,
    now = () => new Date().toISOString(),
    operationId = () => randomUUID(),
  } = {}) {
    super();
    this.clientFactory = clientFactory;
    this.clientOptions = clientOptions;
    this.cliPath = cliPath;
    this.environment = environment;
    this.spawnProcess = spawnProcess;
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

  async signIn({ mode = 'browser' } = {}) {
    if (mode !== 'browser' && mode !== 'device') {
      throw new RuntimeFault('invalid_sign_in_mode', `Unsupported Copilot sign-in mode '${mode}'.`, 400);
    }
    if (!this.cliPath) {
      throw new RuntimeFault('copilot_cli_unavailable', 'The packaged Copilot CLI path is required for sign-in.', 503);
    }
    if (this.operations.size > 0) {
      throw new RuntimeFault('sign_in_in_progress', 'Copilot sign-in is already in progress.', 409);
    }

    const id = this.operationId();
    const operation = { id, child: null, cancellationRequested: false, finished: false };
    this.operations.set(id, operation);
    this.#publishSignIn(operation, 'starting', 'Starting GitHub sign-in.');

    const loginArgs = ['login', mode === 'device' ? '--device-code' : '--web-flow'];
    const isJavaScript = /\.[cm]?js$/i.test(this.cliPath);
    const command = isJavaScript ? process.execPath : this.cliPath;
    const args = isJavaScript ? [this.cliPath, ...loginArgs] : loginArgs;

    try {
      operation.child = this.spawnProcess(command, args, {
        env: copilotChildEnvironment(this.environment),
        stdio: 'inherit',
        windowsHide: true,
      });
    } catch {
      void this.#finishSignIn(operation, 'failed');
      return { id };
    }

    operation.child.once('spawn', () => {
      if (!operation.finished) {
        this.#publishSignIn(
          operation,
          'waiting_for_person',
          mode === 'browser'
            ? "A browser should open for GitHub sign-in. If it doesn't, cancel this sign-in and run the official Copilot CLI sign-in in a terminal, then try again."
            : "Finish GitHub device sign-in in the terminal running Floe. If you can't see the code, cancel this sign-in and run the official Copilot CLI sign-in in a terminal, then try again.",
        );
      }
    });
    operation.child.once('error', () => void this.#finishSignIn(operation, 'failed'));
    operation.child.once('exit', code => {
      const outcome = operation.cancellationRequested ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      void this.#finishSignIn(operation, outcome);
    });
    return { id };
  }

  async cancelSignIn(id) {
    const operation = this.operations.get(id);
    if (!operation || operation.finished) {
      throw new RuntimeFault('sign_in_not_found', `Copilot sign-in operation '${id}' is not active.`, 404);
    }
    operation.cancellationRequested = true;
    operation.child?.kill();
  }

  async close() {
    for (const operation of this.operations.values()) {
      operation.cancellationRequested = true;
      operation.child?.kill();
    }
  }

  #sdkOptions() {
    const { gitHubToken: _ignoredToken, connection, env: optionEnvironment, ...options } = this.clientOptions;
    const environment = copilotChildEnvironment({ ...this.environment, ...optionEnvironment });
    const safeConnection = connection && typeof connection === 'object'
      ? { ...connection, ...(connection.env ? { env: copilotChildEnvironment(connection.env) } : {}) }
      : connection;
    return {
      ...options,
      ...(safeConnection ? { connection: safeConnection } : {}),
      env: environment,
      useLoggedInUser: true,
    };
  }

  async #stopClient(client) {
    if (!client?.stop) return;
    try {
      await client.stop();
    } catch (error) {
      this.emit('diagnostic', `Copilot account check could not stop its SDK client: ${error.message}`);
    }
  }

  async #finishSignIn(operation, outcome) {
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

  #publishSignIn(operation, status, message) {
    this.emit('sign_in', {
      operationId: operation.id,
      engine: 'copilot',
      status,
      message,
    });
  }
}
