/**
 * Where a Copilot login can come from, and the person's saved choice between them.
 * @invariant Only the choice ({ source }) is persisted. Tokens are resolved fresh for each SDK client
 * and never stored, published in state or events, or included in errors.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeFault } from '../errors.mjs';
import { githubUserLogin } from './github-user.mjs';

export const LOGIN_SOURCES = Object.freeze(['app', 'github-cli', 'environment']);
export const LOGIN_CHOICE_FILE = 'floe-login.json';

// A token passed as CopilotClientOptions.gitHubToken reaches the CLI through an environment variable
// (`--auth-token-env`). SDK 1.0.19 doesn't document which authType it reports, so both token types are accepted.
export const CHOSEN_LOGIN_AUTH_TYPES = new Set(['token', 'env']);

const CREDENTIAL_ENVIRONMENT_KEYS = new Set([
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_DISABLE_KEYTAR',
  'COPILOT_SDK_AUTH_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);
// Documented Copilot CLI precedence for environment tokens.
const ENVIRONMENT_TOKEN_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const GITHUB_CLI_TIMEOUT_MS = 10_000;

const SOURCE_LABELS = Object.freeze({
  app: 'Floe sign-in',
  'github-cli': 'GitHub CLI login',
  environment: 'environment token',
});

export function copilotChildEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !CREDENTIAL_ENVIRONMENT_KEYS.has(key.toUpperCase())),
  );
}

export function loginSourceLabel(source) {
  return SOURCE_LABELS[source];
}

export function normalizeAcceptedLogins(value = ['app']) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuntimeFault('invalid_login_source', 'acceptedLogins must be a non-empty array of login sources.', 400);
  }
  for (const source of value) {
    if (!LOGIN_SOURCES.includes(source)) {
      throw new RuntimeFault('invalid_login_source', `Unsupported Copilot login source '${source}'.`, 400);
    }
  }
  return Object.freeze([...new Set(value)]);
}

/** The SDK rejects gitHubToken with RuntimeConnection.forUri: an external server manages its own auth. */
export function existingLoginsUnavailableReason(clientOptions) {
  return clientOptions.connection?.kind === 'uri'
    ? "Existing logins can't be used while Floe connects to an external Copilot server."
    : undefined;
}

function choicePath(baseDirectory) {
  return path.join(baseDirectory, LOGIN_CHOICE_FILE);
}

export async function readLoginChoice(baseDirectory) {
  try {
    const { source } = JSON.parse(await readFile(choicePath(baseDirectory), 'utf8'));
    return LOGIN_SOURCES.includes(source) && source !== 'app' ? source : undefined;
  } catch {
    return undefined;
  }
}

export async function saveLoginChoice(baseDirectory, source) {
  await mkdir(baseDirectory, { recursive: true });
  await writeFile(choicePath(baseDirectory), `${JSON.stringify({ source }, null, 2)}\n`, 'utf8');
}

export async function clearLoginChoice(baseDirectory) {
  try {
    await unlink(choicePath(baseDirectory));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function environmentToken(environment) {
  const entries = Object.entries(environment);
  for (const name of ENVIRONMENT_TOKEN_KEYS) {
    const value = entries.find(([key]) => key.toUpperCase() === name)?.[1];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** The SDK can't read the gh CLI login, so ask gh. Missing or signed-out gh means no token. */
function githubCliToken(environment, spawnProcess) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnProcess('gh', ['auth', 'token'], {
        env: copilotChildEnvironment(environment),
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GITHUB_CLI_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const chunks = [];
    child.stdout?.on('data', chunk => chunks.push(String(chunk)));
    child.once('error', () => resolve(undefined));
    child.once('close', code => {
      const token = chunks.join('').trim();
      resolve(code === 0 && token ? token : undefined);
    });
  });
}

/** Environment the Copilot child would see; also where an 'environment' login is read from. */
export function loginEnvironment(clientOptions, environment) {
  return clientOptions.connection?.env ?? { ...environment, ...clientOptions.env };
}

export function resolveLoginToken(source, { clientOptions, environment = process.env, spawnProcess = spawn }) {
  const lookup = loginEnvironment(clientOptions, environment);
  if (source === 'environment') return Promise.resolve(environmentToken(lookup));
  if (source === 'github-cli') return githubCliToken(lookup, spawnProcess);
  return Promise.resolve(undefined);
}

/**
 * The single resolver for which login an SDK client uses. Returns { source: 'app' } when no choice is saved,
 * otherwise { source, gitHubToken?, unavailable? }. A missing token is reported, never replaced by another login.
 */
export async function resolveSavedLogin({
  clientOptions,
  environment = process.env,
  spawnProcess = spawn,
  acceptedLogins = LOGIN_SOURCES,
}) {
  const { baseDirectory } = clientOptions;
  const source = await readLoginChoice(baseDirectory);
  if (!source) return { source: 'app' };
  if (!acceptedLogins.includes(source)) {
    await clearLoginChoice(baseDirectory);
    return { source: 'app' };
  }
  const unavailable = existingLoginsUnavailableReason(clientOptions);
  if (unavailable) return { source, unavailable };
  const gitHubToken = await resolveLoginToken(source, { clientOptions, environment, spawnProcess });
  return gitHubToken ? { source, gitHubToken } : { source };
}

/**
 * Identity for a token Copilot accepted. The SDK's getAuthStatus() proves Copilot accepts the token
 * (and may give the host) but, for gitHubToken clients, may omit the login; GitHub's /user then supplies it.
 */
export async function tokenIdentity(auth, gitHubToken, fetchImpl) {
  if (!auth?.isAuthenticated) return undefined;
  const login = typeof auth.login === 'string' && auth.login
    ? auth.login
    : await githubUserLogin(gitHubToken, auth.host, fetchImpl);
  return login ? { login, ...(auth.host ? { host: auth.host } : {}) } : undefined;
}

async function identify(gitHubToken, { createClient, stopClient, fetchImpl }) {
  let client;
  try {
    client = await createClient(gitHubToken);
    await client.start();
    return await tokenIdentity(await client.getAuthStatus(), gitHubToken, fetchImpl);
  } catch {
    return undefined;
  } finally {
    await stopClient(client);
  }
}

/**
 * Finds which of the given sources currently hold a login Copilot accepts, using a short-lived
 * client per token (createClient) that is always stopped (stopClient). Returns { source, login, host? }.
 */
export async function discoverExistingLogins(sources, { createClient, stopClient, fetchImpl, ...context }) {
  const found = [];
  for (const source of sources) {
    const token = await resolveLoginToken(source, context);
    const identity = token ? await identify(token, { createClient, stopClient, fetchImpl }) : undefined;
    if (identity) found.push({ source, ...identity });
  }
  return found;
}
