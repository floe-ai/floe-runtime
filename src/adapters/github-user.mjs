/**
 * Looks up the GitHub account that owns a token, via GitHub's documented REST endpoint
 * "Get the authenticated user" (GET /user): https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 * @invariant The token is only sent in the Authorization header; it is never logged or put in errors.
 */
const REQUEST_TIMEOUT_MS = 10_000;

function hostName(host) {
  if (typeof host !== 'string' || !host.trim()) return 'github.com';
  const value = host.trim();
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** REST API base for a Copilot host: github.com, GHE.com data residency, or GitHub Enterprise Server. */
export function githubApiBase(host) {
  const name = hostName(host);
  if (!name) return undefined;
  if (name === 'github.com' || name === 'api.github.com') return 'https://api.github.com';
  if (name.endsWith('.ghe.com')) return `https://api.${name}`;
  return `https://${name}/api/v3`;
}

/** Returns the token owner's login, or undefined if GitHub doesn't confirm it. */
export async function githubUserLogin(token, host, fetchImpl = globalThis.fetch) {
  const base = githubApiBase(host);
  if (!base || typeof fetchImpl !== 'function') return undefined;
  try {
    const response = await fetchImpl(`${base}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const { login } = await response.json();
    return typeof login === 'string' && login ? login : undefined;
  } catch {
    return undefined;
  }
}
