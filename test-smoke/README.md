# Smoke tests (real binaries, real cost)

These tests are the ONLY tests in this repository that spawn the real
`codex`/`copilot` CLIs. Everything under `test/` runs against the fakes in
`test/fake-codex.mjs`/`test/fake-copilot.mjs` and never touches a real
process or a real account - that suite is fast, hermetic and free. This one
is neither: it costs real API credits and takes real wall-clock time
(process spawns, real model turns, a real SIGKILL + resume cycle).

Run it explicitly, never as part of `npm test`:

```
npm run smoke
```

Each test probes for the binary/authentication it needs FIRST and skips
cleanly (with an explicit reason printed by `node --test`) if it is
unavailable, rather than failing the suite. You should expect to see:

- Copilot tests run for real if `copilot` is installed and logged in.
- Codex tests SKIP with `Codex unavailable: spend cap reached` until the
  workspace's spend cap resets (October 1st, per the user who owns this
  workspace at the time this suite was written) - this is a live
  confirmation of the F9 `usage_limit_exceeded` fault detection in
  `src/adapters/codex.mjs`, not a bug in the suite.

Coverage is intentionally minimal (one trivial prompt per scenario, the
cheapest available model - `claude-haiku-4.5` for Copilot) to keep the real
cost small while still exercising:

1. Copilot handshake over the real subprocess (regression guard for the B3
   Windows executable-resolution defect).
2. Copilot `session/new` returning a live model catalogue and
   `session/set_model` actually changing the model (B1 guard).
3. Copilot `session/close` (B2 guard).
4. Copilot resume across a REAL process death: start a session, plant a
   codeword, SIGKILL the subprocess (not a graceful `close()`), start a
   brand-new `CopilotRuntime`, `resume()` the session, and confirm the agent
   still recalls the codeword. Also asserts replayed history is correctly
   flagged `replay: true` and is never mistaken for live activity.
5. Codex: the identical resume-across-death test, written and ready to run
   the moment the spend cap resets - it currently skips cleanly instead of
   failing.
