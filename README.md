# floe-runtime

A shared runtime for driving Codex and Copilot coding agents with one common
lifecycle: start, run, interrupt, quiesce, retire, reuse a session, and
validate structured output. Codex uses its app-server protocol; Copilot uses
the official `@github/copilot-sdk`.

This package has no dependency on a consuming app. Callers own their prompts,
JSON Schemas, and permission policy; floe-runtime owns the runtime lifecycle.

## Install

Requires Node.js `^20.19.0 || >=22.12.0`.

Use a workspace/path reference from a consuming app's `package.json`:

```json
{ "dependencies": { "floe-runtime": "file:../floe-runtime" } }
```

## The Runtime interface

Both adapters (`CodexRuntime`, `CopilotRuntime`) implement the same shape:

```js
import { CodexRuntime } from 'floe-runtime/adapters/codex';
// or: import { CopilotRuntime } from 'floe-runtime/adapters/copilot';

const runtime = new CodexRuntime({ model: 'gpt-5-codex', timeoutMs: 20 * 60 * 1000 });

await runtime.start();                 // starts the selected backend

const result = await runtime.run(
  'worker',                            // role label - only used in error messages
  { prompt: 'Implement X...', schema }, // prompt text + optional JSON Schema for the reply
  '/path/to/workspace',                 // cwd
  (sessionId, meta) => { /* turn is starting; meta.session.action is 'fresh'|'reused'|'refreshed' */ },
  { model: 'gpt-5-codex', timeoutMs: 10 * 60 * 1000, permissions: { /* backend-specific */ } },
  { sessionId: previousId, scope: issueDigest }, // continuation hint for session reuse
);
// result: { report, text, threadId|sessionId, items, usage, elapsedMs, ... }

const conversationId = result.threadId || result.sessionId;
await runtime.interrupt(conversationId);  // cancel an active turn
await runtime.quiesce(conversationId);    // confirm the turn/session is fully stopped
await runtime.retire(conversationId);     // release the conversation
await runtime.close();                    // stop the selected backend
```

Events: `runtime.on('ready'|'lost'|'diagnostic'|'notification'|'request'|'activity', ...)`.
`'request'` fires for subprocess-initiated JSON-RPC requests and SDK Copilot
permission callbacks - see
[Permission policy](#permission-policy) below for how these get answered.
`'activity'` fires a backend-neutral event for every tool/command the agent
runs - see [Activity events](#activity-events) below.

## Activity events

Both adapters normalize command and tool execution into one backend-neutral
`activity` event shape:

```js
runtime.on('activity', event => { /* ... */ });
// { runtime: 'codex'|'copilot', sessionId, turnId, id, kind, status,
//   title, command, startedAt, endedAt, raw }
```

- `kind` is normalized to one of `command`, `file`, `search`, `fetch`,
  `think`, `tool`, `other` (see `src/activity.mjs`).
- `status` is normalized to `started`, `completed`, or `failed`. Codex and
  the Copilot SDK both emit a correlated start and terminal event stream.
- `raw` is the untouched backend notification payload, kept as an escape
  hatch for callers that need backend-specific detail beyond the normalized
  fields.

## Permission policy

Every permission or approval request (Codex's
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, confirmation-shaped `mcpServer/elicitation/request`;
and Copilot SDK permission callbacks) is normalized into one shape and can be
answered with one policy function instead of separate backend-specific code:

```js
const runtime = new CodexRuntime({
  permissionPolicy(request) {
    // request: { runtime, sessionId, id, title, kind, options, raw }
    // options: [{ id, decision, label }]
    if (request.kind === 'command') return 'allow_once';
    return 'reject_once'; // one of PERMISSION_DECISIONS in src/permissions.mjs
  },
});
```

**Precedence** (highest wins):
1. An explicit `runtime.on('request', ...)` listener. SDK Copilot listeners
   receive a `permission/request` message and decide it through
   `runtime.respond(message.id, { decision:
   'allow_once'|'allow_always'|'reject_once'|'reject_always'|'cancel' })`.
   `respondError()` denies it. An unanswered SDK request is denied after
   `unhandledRequestTimeoutMs`.
2. `permissionPolicy(request)` - called only when no `'request'` listener is
   attached and the request is one floe-runtime recognizes as a permission
   request (`normalizePermissionRequest()` returned non-null). May be async.
3. `defaultPermissionDecision` (default: `'reject_once'`) - used when there
   is no listener, no policy, or the policy's answer isn't one of the
   request's own `options`.

**A turn must never hang forever waiting for a human who isn't there.**
Deny-by-default was chosen over an implicit-allow-after-timeout because an
unreviewed auto-allow is unsafe, while an instant deny is always safe and
deterministic. As a last-resort safety net independent of the above,
`unhandledRequestTimeoutMs` (default 20000ms) auto-declines *any* inbound
request - even ones `normalizePermissionRequest()` doesn't recognize, or ones
a caller's own `'request'` listener forgets to answer - by calling
`respondError()` if nothing has responded to it in time.

Not every Codex request is a permission request. Real data-form
`mcpServer/elicitation/request` payloads (ones with actual required fields,
not a plain yes/no confirmation) return `null` from
`normalizePermissionRequest()` because no generic policy can fabricate typed
answers. They remain available through the `'request'` event, subject to the
same unhandled-request timeout.

## Schema ownership

floe-runtime ships only the validation *mechanism* (`validate`,
`extractStructuredOutput`, `promptInstructionFor` in `src/schema.mjs`). Each
consuming app defines its own per-role JSON Schemas and prompt templates and
passes the finished `{ prompt, schema }` into `run()`. Codex can enforce
`schema` server-side (`outputSchema` on `turn/start`). Copilot SDK prompts
should request JSON matching the schema (see `promptInstructionFor(schema)`),
then use the shared client-side validation path.

## Adapters

### CodexRuntime (`src/adapters/codex.mjs`)

Spawns `codex app-server` and drives its thread/turn protocol. `run()` starts
an ephemeral thread and turn; `settings.permissions` is passed straight
through as Codex's own `{ approvalPolicy, sandbox, sandboxPolicy }` shape -
floe-runtime does not define access-level vocabulary, that's the caller's
policy to compute. Session reuse checks a live thread's status via
`thread/read` before reusing it (mirrors Codex's own idle-ephemeral-thread
semantics). `quiesce()` interrupts the active turn, polls until no turns are
in progress, then enumerates and terminates background terminals.
`retire()` calls `thread/unsubscribe`, falling back to local-only retirement
if that optional API is unavailable.

### CopilotRuntime (`src/adapters/copilot.mjs`)

Copilot uses the official `@github/copilot-sdk@1.0.13` and its bundled runtime.
The adapter subscribes before sending a prompt. A turn completes at
`session.idle`; `assistant.turn_end` is a model-call boundary within the agent
loop. Cancellation waits for abort acknowledgement followed by `session.idle`;
missing idle raises `quiescence_unknown`.

`session.error`, model-call failures, missing final messages, aborted turns,
and incomplete structured output are reported as distinct failures.
`systemMessage` uses the SDK append/customize form so SDK guardrails remain
active. `tools`, `availableTools`, and `excludedTools` configure host-owned
tools. Model listing and selection use SDK APIs; authentication is owned by
the SDK runtime.

`input.blocks` accepts text, file, directory, selection, blob, and image
blocks, which are mapped to SDK message options. Other block types, including
embedded context, fail with `unsupported_prompt_block` before sending.

## Parity surface

Both adapters implement the same additional methods beyond the core `run`/
`interrupt`/`quiesce`/`retire`/`close` lifecycle. Where a backend has no
equivalent capability, the method throws a `RuntimeFault` with code
`capability_unsupported` rather than silently no-op'ing - always check
`runtime.capabilities()` first if a call is conditional.

| Method | Codex | Copilot | Notes |
| --- | --- | --- | --- |
| `setModel(id, modelId)` | ✅ applied on the next `turn/start` | ✅ SDK session model selection | |
| `releaseSession(id)` / `retire(id)` | ✅ `thread/unsubscribe` | ✅ SDK session disconnect | |
| `setMode(id, mode)` | ❌ unsupported | ❌ unsupported | Codex has no session-mode concept |
| `setPermissions(id, level)` | ✅ `approvalPolicy`/`sandbox`/`sandboxPolicy` override, applied next `turn/start` | ❌ unsupported; configure `permissionPolicy` at construction | |
| `setGoal(id, objective, opts)` | ✅ `thread/goal/set`\|`get`\|`clear` (`opts.maxCredits` unsupported) | ❌ unsupported | |
| `compact(id, focus)` | ✅ `thread/compact/start` | ❌ unsupported | |
| `usage(id)` | ✅ `account/usage/read` + `account/rateLimits/read` | ❌ unsupported | |
| `steer(id, text)` | ✅ `turn/steer` (requires an active turn) | ❌ unsupported | |
| `fork(id)` | ✅ `thread/fork` | ❌ unsupported | |
| `listSessions()` | ✅ `thread/list` | ✅ SDK `listSessions()` | |
| `resume(id)` | ✅ `thread/resume` | ✅ SDK `resumeSession()` | |
| streaming (`'stream'` event) | ✅ agent-message, reasoning, and command-output deltas | ✅ assistant-message and reasoning deltas | |
| rich prompt input (`input.blocks`) | ✅ passed straight through to `turn/start` | ✅ text blocks normalized to the SDK prompt | |
| `availableCommands(id)` | ❌ unsupported | ❌ unsupported | The SDK has no command-advertisement surface |
| `fleetMode(id, prompt)` | ❌ unsupported | ❌ unsupported | |
| `scheduleRecurring(id, interval, prompt)` | ❌ unsupported | ❌ unsupported | |
| `scheduleOnce(id, delay, prompt)` | ❌ unsupported | ❌ unsupported | |

Call `runtime.capabilities()` to get this table as data:

```js
runtime.capabilities();
// { setModel, releaseSession, setMode, setPermissions, setGoal, compact,
//   usage, steer, fork, listSessions, resume, streaming, richPrompt,
//   availableCommands, fleetMode, scheduleRecurring, scheduleOnce }
```

### Streaming events

```js
runtime.on('stream', event => { /* ... */ });
// { runtime, sessionId|threadId, turnId, kind: 'text'|'reasoning'|'commandOutput', delta, raw }
```

Fires live incremental text/reasoning/command-output as the agent produces
it, in addition to the final result `run()` resolves with.

## No polling, anywhere

Every wait in this package settles from a pushed event (a JSON-RPC
notification, or a turn's own settlement promise) or a single timeout - never
by re-reading state on a fixed interval. This is a hard design rule, not a
style preference:

- `quiesce()` on both adapters awaits the active turn's settlement promise
  directly (`Promise.race([task.settlement, timeout])`) instead of looping on
  `this.turns.has(id)`.
- Codex's `quiesce()` waits for a single `thread/status/changed` or
  `turn/completed` notification (see `#awaitThreadIdleSignal()`), then takes
  exactly one confirmatory `thread/read` - never a retry loop.
- The `do...while` loops over `thread/backgroundTerminals/list`'s cursor are
  **pagination** (enumerating pages of a list), not polling - they never
  re-request the same page waiting for a state change.
- The single background-terminal list read immediately after terminating
  terminals is a **read-after-write confirmation**, not a retry loop.

If you ever see a `while (...) await new Promise(resolve => setTimeout(resolve, N))`
loop reappear anywhere in `src/`, it is a regression - open an issue.

## Conversation lifetime and resumability

**A conversation stays alive - and resumable after an app closes and reopens
- until the app explicitly calls `retire()`. A completed turn never ends a
conversation by itself.**

- Persistence is a per-call **choice**, defaulting to persistent:
  `run(role, input, cwd, onStart, settings)` treats `settings.ephemeral` as
  `false` unless you pass `true`. Codex creates the thread with
  `ephemeral: false` by default (`thread/resume` can restore it later);
  passing `settings.ephemeral: true` opts a single sensitive one-shot task out
  of persistence - that thread can never be `resume()`d afterwards. Copilot
  sessions can be resumed through the SDK when the backend retains them.
- **Discovery after a restart**: an app that restarts has no in-memory record
  of its previous sessionId/threadId beyond whatever *it* chooses to persist
  (e.g. in its own database). `listSessions()` (`thread/list` / `session/list`)
  is the load-bearing way to enumerate what the backend still knows about if
  you need to rediscover work. Once you have an id, pass it back in as
  `continuation.sessionId`/`continuation.threadId` on your next `run()` call -
  both adapters transparently call `resume()` internally when handed an id
  they are not already tracking in this process, so resuming "just works" as
  part of the normal `run()` flow; you rarely need to call `resume()`
  directly.
- **Only `retire()` ends a conversation.** `quiesce()` merely confirms the
  turn/session is idle (a precondition for reuse or retirement); it never
  deletes anything. A finished turn leaves the session fully intact and
  reusable.
- **Orphan sweep**: `sweepOrphans({ maxAgeMs })` releases sessions/threads
  this runtime instance is not currently tracking that have gone idle longer
  than `maxAgeMs` (default: 21 days - generous, on purpose, so a crash never
  costs you a real conversation). It never sweeps anything this instance is
  actively tracking, and never sweeps anything without a parseable
  last-activity timestamp (it leaves those alone rather than guessing). Call
  it periodically (e.g. on app startup) against your own persisted list of
  session ids, or against `listSessions()`'s full backend list.
- **Context window growth**: conversations cannot grow forever. The answer is
  `compact(sessionId, focus)` (P6) - it summarizes history to reclaim context
  budget - not dropping the conversation. Call it proactively (e.g. from a
  `usage()`/`thread/tokenUsage/updated`-driven heuristic) before a
  conversation's context window is actually exhausted.
- **Resuming a Codex thread clears its goal server-side.** Confirmed live:
  `thread/resume` is immediately followed by a `thread/goal/cleared`
  notification. `resume(threadId, { goal })` re-applies the last known
  objective automatically: pass it explicitly (the reliable path across a
  full process restart, e.g. from your own persisted state or a Fleet
  recovery) or omit it to fall back to this runtime instance's own in-memory
  record of the last `setGoal()` call for that thread (only useful for a
  same-process resume). A successful re-apply publishes `'goalReapplied'`; a
  failed one publishes an unmissable `'goalReapplyFailed'` event plus a
  diagnostic - `resume()` does not fail outright over this, since the
  conversation itself remains usable.

## Distinguishing "out of money" from a crash

A Codex spend or quota limit must not look like a generic task failure:

- A spend-cap turn arrives as an ordinary
  `turn/completed` with `turn.status === 'failed'` and
  `turn.error.codexErrorInfo === 'usageLimitExceeded'`. This is detected and
  raised as a distinct `usage_limit_exceeded` `RuntimeFault` (not the generic
  `turn_failed`), carrying the backend's own human-readable message.

## Other Codex notifications now surfaced (not silently dropped)

Confirmed arriving from the real `codex app-server` and previously ignored
entirely:

- `account/rateLimits/updated` - the early warning before a spend-cap wall.
  Surfaced as a `'usage'` event.
- `error` - a server-level error. Surfaced as a plain-text `'diagnostic'`
  event AND a structured `'serverError'` event.
- `hook/started` / `hook/completed` - lifecycle hooks. Folded into the
  normalized `'activity'` stream (`kind: 'hook'`) when tied to an active
  turn/thread; otherwise a diagnostic.
- `mcpServer/startupStatus/updated` - MCP server startup progress (also
  explains an otherwise-confusing stderr line about an MCP server failing to
  authenticate). Surfaced as a diagnostic, plus a structured `'notice'` event
  (`kind: 'mcpServerStartupStatus'`) when a thread is known.
- `thread/settings/updated` - settings changed server-side. Surfaced as a
  `'notice'` event (`kind: 'settingsChanged'`).

Note: never reuse the `'diagnostic'` event **type** in a `publish()` call -
`publish()` also fires a plain `emit(type, data)`, and existing `'diagnostic'`
listeners expect a plain string, not an object. Structured versions of these
signals use distinct type names (`'notice'`, `'serverError'`, `'usage'`).

## Events as first-class

There is no daemon, no shared pool, and no transport/IPC layer here - every
app owns its own independent `floe-runtime` instance. "Events as first-class"
means the runtime's activity/stream/turn-lifecycle events are also captured
as a serialisable, replayable stream, so they can be persisted, logged, and
picked back up mid-conversation - not that there is a socket server anywhere.

Every event is wrapped in a small JSON-safe envelope (no live object
references - safe to `JSON.stringify`, log, or store):

```js
{ seq, conversationId, type, replay, at, data }
```

- `seq` - a monotonic integer, per `conversationId` (a threadId/sessionId).
- `type` - `'activity'`, `'stream'`, `'turn'`, `'replay'`, `'replayComplete'`,
  or `'gap'`.
- `replay` - `true` while the event is part of replayed history, `false` once
  activity is live. A `'replayComplete'` event marks the transition.
- `data` - the same shape the matching named event (`'activity'`, `'stream'`,
  etc.) already carries; named events (`runtime.on('activity', ...)`) keep
  working unchanged.

Every published event is also buffered per-conversation (bounded,
`replayBufferSize` events per conversation, default 500) so a consumer that
falls behind gets an explicit **"you missed N events"** signal - a synthetic
`{ type: 'gap', data: { missed } }` envelope - rather than silently losing
history.

### Consuming the stream

```js
for await (const envelope of runtime.events(sessionId)) {
  if (envelope.type === 'gap') { /* re-sync from your own persisted state */ }
  if (envelope.replay) { /* this is replayed history, not live activity - don't re-run side effects */ }
  // envelope.type, envelope.data - no manual id correlation needed
}
```

`runtime.events(conversationId, { since })` returns an async iterable that
replays any buffered backlog after `since` first, then yields live events
until you stop iterating (`break`) or the runtime disconnects (`'lost'`). The
promise-returning `run()` API still works exactly as before - `events()` is
an additive way to observe a turn's live activity, not a replacement.

## Fleet: the swarm substrate

`Fleet` (in `src/fleet.mjs`) lets one app run many agents at once, across
**both** backends simultaneously - it is the substrate for swarms, not the
orchestrator. It owns pooling, process isolation, spend limits, concurrency
control, and one uniform event stream. It does **not** own orchestration
policy: no task graph, no work-item scheduler, no agent-to-agent message bus.
Who does what, in what order, and how results are combined stays entirely
your app's decision - `Fleet` just hands you agent handles and runs turns on
them.

There is still no daemon, no shared pool across apps, and no IPC layer - a
`Fleet` is an in-process object your app constructs and owns, exactly like a
single `Runtime`, just managing several of them.

```js
import { Fleet, CopilotRuntime, CodexRuntime } from 'floe-runtime';

const fleet = new Fleet({
  backends: {
    copilot: () => new CopilotRuntime({}),
    codex: () => new CodexRuntime({}),
  },
  defaultBackend: 'copilot',       // Copilot is first-call; Codex stays fully selectable per agent
  maxSessionsPerProcess: 8,        // shard: agents sharing one subprocess/stdio pipe
  maxProcesses: Infinity,          // hard cap on subprocesses per backend
  maxConcurrentTurns: 16,          // fleet-wide in-flight turn cap
  autoRecover: true,               // re-establish persistent agents after a shard crash
  budget: { ceiling: 5.00, warnAt: [0.5, 0.8] },
});

const agentId = fleet.requestAgent({ role: 'worker', cwd: '/repo', backend: 'copilot' });
const result = await fleet.run(agentId, { prompt: 'do the thing' });
await fleet.retireAgent(agentId); // the only thing that ends this agent's conversation
```

### Unbounded agents, bounded execution

`requestAgent()` always succeeds immediately and never blocks on capacity -
register as many agent handles as you want; there is no artificial ceiling.
Actually **running** a turn is what's bounded, by two independent knobs:

- **Sharding** (`maxSessionsPerProcess`, `maxProcesses`) - how many backend
  subprocesses exist and how many sessions live on each. A shard is a plain
  `Runtime` instance under the hood; agents are assigned to one lazily, on
  their first `run()` call (never eagerly at `requestAgent()` time).
- **Concurrency** (`maxConcurrentTurns`) - how many turns may be in flight
  across the whole fleet at once.

When either limit is reached, new work **queues** (FIFO, with an optional
per-call `{ priority }` so an urgent agent can jump ahead) rather than
spawning without bound or thrashing the host machine. The queue drains
**purely from push events** - a turn settling, an agent retiring, a shard
dying - never from a timer or a retry loop; see "No polling" above, which
applies to `Fleet` exactly as it does to a bare `Runtime`.

### Stable agent handles, mixed backends

`requestAgent({ role, cwd, model, backend?, scope?, ephemeral? })` returns a
durable `agentId` string. Callers keep this id and never need to know which
process or session it currently lives on - `Fleet` remaps it internally, even
across a crash-recovery reassignment to a new shard (see below). A single
fleet can mix Copilot and Codex agents; `fleet.capabilities('copilot')` /
`fleet.capabilities('codex')` / `fleet.capabilities(agentId)` give the same
capability map a bare `Runtime` would, so you can check before calling a
parity method instead of discovering a mismatch via a thrown fault -
`Fleet` never silently degrades an unsupported call; it still throws
`capability_unsupported`.

### One unified event stream

Every event `Fleet` emits reuses the exact same envelope (`seq`, `replay`,
`conversationId`, `type`, `data`) documented above, plus `agentId` and
`backend` in `data` so a consumer can tell which agent and which backend
produced it:

```js
fleet.on('event', envelope => { /* every agent's activity, fleet-wide */ });
for await (const envelope of fleet.events(agentId)) { /* just this agent */ }
```

### Sharding and crash recovery

When a shard's subprocess dies, only that shard's agents are affected -
`Fleet` emits `'shardLost'` naming exactly which `agentIds` were hit, never a
silent partial failure. What happens next depends on how each agent was
created:

- **Persistent agents** (the default - see "Conversation lifetime" above):
  if `autoRecover` is enabled, `Fleet` automatically assigns a new shard and
  calls `resume()` to restore the conversation, emitting `'agentRecovering'`
  then `'agentRecovered'` (or `'agentLost'` if resume itself fails). This is
  the direct payoff of persistence-by-default: a dead process no longer means
  a dead conversation. If a goal was ever set for the agent (`setGoal()`),
  `Fleet` re-applies it on the fresh shard via `resume(sessionId, { goal:
  agent.lastGoal })` - the fresh runtime instance has no in-memory goal
  history of its own, so `Fleet` must supply it explicitly (see "Resuming a
  Codex thread clears its goal" above).
- **Ephemeral agents** (`requestAgent({ ephemeral: true })`) have nothing to
  resume by construction. `Fleet` never pretends otherwise - it reports each
  one individually and clearly as `'agentLost'` with `recoverable: false`.

### Swarm-wide spend cap

`budget: { ceiling, warnAt, interruptOnCeiling }` is enforced as **admission
control**, not mere observation: once aggregate spend (from the same
structured `usage()`/usage-event surface documented elsewhere in this README)
reaches `ceiling`, `Fleet` refuses to start new turns (`run()` rejects with
`budget_exceeded`) and rejects any already-queued-but-not-yet-admitted work.
Warning thresholds (`warnAt`, default `[0.5, 0.8]`) emit `'budgetWarning'`
events on the way there. Whether in-flight turns are also interrupted is
separately configurable via `interruptOnCeiling` (default `false` - let
active work finish cleanly). Reaching the ceiling emits a **distinct**
`'budgetCeilingReached'` event, deliberately separate from a normal
drained-empty queue, so your app can tell "the swarm finished" apart from
"the swarm ran out of budget."

Enforcement fidelity is honestly different per backend - `Fleet` does not
pretend otherwise:

| Backend | Fleet-level admission control | Backend-enforced cap |
| --- | --- | --- |
| Copilot SDK | Yes | Unsupported |
| Codex | Yes | No - Codex has no credit cap of any kind; measurement + fleet-level admission control is all that's possible |

Spend is aggregated as **latest known cost per agent**, summed - never as a
running total of raw usage-event deltas, because both backends' usage
notifications report a session's cumulative cost-to-date, not a per-event
increment (double-counting them would over-report spend).

### Concurrency and queueing

`maxConcurrentTurns` bounds fleet-wide in-flight turns; excess `run()` calls
queue FIFO, with `run(agentId, input, onStart, settings, { priority })`
letting an urgent agent jump the queue. `Fleet` emits `'queueDepth'` (depth +
active-turn count) and `'admission'` events so an app can show what's
waiting and why. The queue drains only from turn-settlement/shard-loss/agent-
retirement events - never a timer (see "No polling, anywhere").

## Shared modules

- `src/runtime.mjs` - base `Runtime` class: lifecycle, start() dedup, and
  `ready`/`lost`/`diagnostic`/`notification`/`request` event wiring.
- `src/jsonrpc.mjs` - `JsonRpcPeer`: newline-delimited JSON-RPC framing over
  a child process's stdio, request/response correlation, timeouts.
- `src/session-reuse.mjs` - `sessionKey()` (digest of role/cwd/model/settings/
  permissions/scope) and `SessionRegistry` (tracks known sessions and their
  confirmed-stopped state, the precondition for reuse and retirement).
- `src/schema.mjs` - `validate()` (small JSON-Schema-subset validator),
  `extractStructuredOutput()`, `promptInstructionFor()`.
- `src/activity.mjs` - the normalized activity event shape and Codex
  `kind` mapping (`codexActivityKind()`).
- `src/events.mjs` - `EventLog` (the bounded, sequenced, per-conversation
  replay buffer) and `watchEvents()` (the async-iterable live feed backing
  `Runtime#events()`).
- `src/permissions.mjs` - the shared `PERMISSION_DECISIONS` vocabulary and
  `pickOption()` helper used by both adapters' `resolvePermissionRequest()`.
- `src/fleet.mjs` - `Fleet`: the swarm substrate (sharding, crash recovery,
  spend cap, concurrency queueing, mixed-backend unified events) built on top
  of plain `Runtime` instances - see "Fleet: the swarm substrate" above.
- `src/errors.mjs` - `RuntimeFault`, `check()`, `id()`, `digest()`, `redact()`.


## Testing

```
npm test
```

Runs `node --test` against `test/*.test.mjs`, using Codex and Copilot SDK
fixtures to exercise start, run, interrupt, quiesce, retire, and reuse
without live network calls or installed coding-agent CLIs. Fleet tests cover
shard saturation and queueing, persistent and ephemeral crash recovery,
budget admission control, and event-driven queue draining.

## Smoke tests (real binaries, real cost)

```
npm run smoke
```

Runs `node --test` against `test-smoke/*.smoke.test.mjs`. These smoke tests
exercise real Codex and Copilot SDK sessions. `npm test` never runs them;
they require authentication, use API credits, and take longer than fixture
tests. See `test-smoke/README.md` for full details.

Each test checks its required authentication or runtime first and skips with
an explicit reason when unavailable.

Smoke coverage includes session resumption after runtime shutdown and checks
that replayed history is identified as replay rather than live activity.
