// Shared capability vocabulary for the parity surface (Runtime#capabilities()).
// Parity between Codex and Copilot is asymmetric - a method backed by no
// native mechanism on a given backend must declare itself unsupported and
// throw, never silently no-op or fake success. Consumers should check
// `runtime.capabilities()[FEATURE]` before calling a parity method if they
// need to branch on backend support ahead of time.
import { RuntimeFault } from './errors.mjs';

export const FEATURES = Object.freeze([
  'setModel', 'releaseSession', 'setMode', 'setPermissions', 'setGoal', 'compact',
  'usage', 'steer', 'fork', 'listSessions', 'resume', 'streaming', 'richPrompt', 'availableCommands',
  // Swarm batch (S5/S6): fleetMode is Copilot's single-session parallel-subagent fan-out (/fleet) -
  // a DIFFERENT shape from src/fleet.mjs's fleet-of-sessions model, see that module's header comment.
  // scheduleRecurring/scheduleOnce are backend-side timers (/every, /after) - the backend wakes itself;
  // floe-runtime never polls for them.
  'fleetMode', 'scheduleRecurring', 'scheduleOnce',
]);

/** Throws the standard capability_unsupported fault for a backend/feature pair. */
export function unsupported(backend, feature) {
  throw new RuntimeFault('capability_unsupported', `${feature} is not supported by the ${backend} backend.`, 501);
}
