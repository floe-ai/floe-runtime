// Shared helpers for the real-binary smoke suite (test-smoke/ only - never imported by test/).
import { CopilotRuntime } from '../src/adapters/copilot.mjs';
import { CodexRuntime } from '../src/adapters/codex.mjs';

/** Cheapest available Copilot model, per the user's explicit instruction to keep real spend minimal. */
export const CHEAP_COPILOT_MODEL = 'claude-haiku-4.5';

/**
 * Starts a runtime and immediately closes it, just to confirm the binary launches, completes the
 * protocol handshake, and (for Copilot) is authenticated. Returns `{ ok: true }` or
 * `{ ok: false, reason }` - never throws, so callers can use the result to build a clean node:test
 * `skip` reason instead of failing the suite when the environment isn't set up for real runs.
 */
export async function probe(makeRuntime, label) {
  const runtime = makeRuntime();
  try {
    await runtime.start();
    await runtime.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `${label} unavailable: ${error.message}` };
  }
}

export function makeCopilotSdkRuntime(options = {}) {
  return new CopilotRuntime({ timeoutMs: 120000, ...options });
}

export function makeCodexRuntime(options = {}) {
  return new CodexRuntime({ timeoutMs: 120000, ...options });
}

/**
 * Kills the runtime's underlying subprocess with SIGKILL, simulating a genuine crash - unlike
 * runtime.close(), which asks the subprocess to exit gracefully. This is deliberately violent: the
 * resume-across-death smoke tests exist specifically to prove a conversation survives a real, ungraceful
 * process death, not just a clean shutdown.
 */
export function killUngracefully(runtime) {
  const proc = runtime.peer?.process;
  if (!proc || proc.killed) return;
  proc.kill('SIGKILL');
}

/** Waits for the runtime to report its subprocess connection lost, without polling (an event listener). */
export function waitForLost(runtime, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the runtime to report the subprocess lost.')), timeoutMs);
    runtime.once('lost', () => { clearTimeout(timer); resolve(); });
  });
}
