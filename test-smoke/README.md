# Smoke tests (real binaries, real cost)

These tests are the ONLY tests in this repository that spawn real
`codex`/`copilot` runtimes. Everything under `test/` runs against the fakes in
`test/fake-codex.mjs`/`test/fake-copilot.mjs` and never touches a real
process or account.

The pinned Copilot tool gate is provider-free: it runs the bundled native
runtime without a login, invokes tools directly, and never makes a model
request. CI runs it on Windows and Linux:

```
npm run test:native-gates
```

The remaining smoke tests use real accounts and model turns. They cost API
credits and take real wall-clock time (process spawns, model turns, and a real
SIGKILL + resume cycle).

Run it explicitly, never as part of `npm test`:

```
npm run smoke
```

Each authenticated test probes for the binary/authentication it needs FIRST and skips
cleanly (with an explicit reason printed by `node --test`) if it is
unavailable, rather than failing the suite. You should expect to see:

- Copilot tests run for real if `copilot` is installed and logged in.
- Codex tests SKIP with `Codex unavailable: spend cap reached` until the
  workspace's spend cap resets (October 1st, per the user who owns this
  workspace at the time this suite was written) - this is a live
  confirmation of the F9 `usage_limit_exceeded` fault detection in
  `src/adapters/codex.mjs`, not a bug in the suite.

Coverage is intentionally minimal to keep the real cost small while still
exercising:

1. Copilot SDK startup through the bundled runtime and retrieval of the live
   authenticated model catalogue.
2. Codex resume across a REAL process death: start a session, plant a codeword,
   SIGKILL the subprocess (not a graceful `close()`), start a brand-new
   `CodexRuntime`, `resume()` the session, and confirm the agent still recalls
   the codeword. This currently skips cleanly when Codex is unavailable.
