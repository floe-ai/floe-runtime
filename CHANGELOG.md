# Changelog

## Unreleased

### Added

- **Copilot account sign-in.** The account adapter can start the SDK login flow
  without a packaged CLI, publish progress events, accept app-provided answers,
  cancel flows, and optionally open the provider URL. The CLI device-code path
  remains available as a compatibility mode and uses the configured Copilot
  home.
- **Account sign-in contract.** Added engine-neutral state/progress/action and
  answer types. The Copilot login RPC is experimental in SDK 1.0.19; plaintext
  consent is surfaced but cannot be answered until the SDK documents its wire
  format.

## 0.2.0

### Added

- **Copilot reasoning effort.** `settings.effort` (`none`, `low`, `medium`,
  `high`, `xhigh`, `max`) is sent to Copilot when a session is created or
  resumed. Same setting name as the Codex adapter.
- **`result.effort`** on Copilot runs: the effort Copilot reported using, else
  the effort the session was set to, else `null`. `onStart` meta has `effort`.
- **`setModel(id, modelId, { effort })`** on Copilot, Codex and `Fleet`. The
  two-argument form is unchanged.
- **Error codes:** `copilot_effort_unavailable` (400) and
  `copilot_model_switch_rejected` (400).

### Behaviour changes

Apps using the Copilot adapter should check these.

- **B1** A continued `run()` (same live `sessionId`) with a different explicit
  `settings.model` or `settings.effort` now switches the session to it. Before,
  the change was silently ignored. Omitting them keeps the session's current
  model and effort.
- **B2** When Copilot rejects a `setModel()` switch, the session now stays open
  and unchanged, and the call fails with `copilot_model_switch_rejected`.
  Before, any `setModel()` failure ended the session.
- **B3** A run or switch asking for an effort the model does not support now
  fails before the turn starts with `copilot_effort_unavailable`, listing the
  supported levels. Without this check Copilot accepts the session and fails
  the first message without an error code. `setModel()` without an effort is
  also refused when the new model cannot keep the current effort; Copilot
  would otherwise reset it silently.
