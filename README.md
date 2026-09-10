# floe-runtime

A shared subprocess/JSON-RPC runtime for driving AI coding-agent CLIs (Codex,
Copilot, ...) with one common lifecycle: spawn the CLI in its protocol/server
mode, frame newline-delimited JSON-RPC messages, correlate requests and
responses, manage session/turn start-interrupt-quiesce-retire, apply a
session-reuse policy, and validate the agent's final structured JSON output.

This package has no dependency on any consuming app - it does not know about
Codex "roles", Star Map's schemas, or Floe's UI. Callers own their prompts,
JSON Schemas, and permission policy; floe-runtime owns the plumbing.

## Install

This is a standalone local package (not yet published). Depend on it via a
workspace/path reference, e.g. in a consuming app's `package.json`:

```json
{ "dependencies": { "floe-runtime": "file:../floe-runtime" } }
```

## The Runtime interface

Both adapters (`CodexRuntime`, `CopilotRuntime`) implement the same shape:

```js
import { CodexRuntime } from 'floe-runtime/adapters/codex';
// or: import { CopilotRuntime } from 'floe-runtime/adapters/copilot';

const runtime = new CodexRuntime({ model: 'gpt-5-codex', timeoutMs: 20 * 60 * 1000 });

await runtime.start();                 // spawns the subprocess, performs the handshake

const result = await runtime.run(
  'worker',                            // role label - only used in error messages
  { prompt: 'Implement X...', schema }, // prompt text + optional JSON Schema for the reply
  '/path/to/workspace',                 // cwd
  (sessionId, meta) => { /* turn is starting; meta.session.action is 'fresh'|'reused'|'refreshed' */ },
  { model: 'gpt-5-codex', timeoutMs: 10 * 60 * 1000, permissions: { /* backend-specific */ } },
  { sessionId: previousId, scope: issueDigest }, // continuation hint for session reuse
);
// result: { report, text, threadId|sessionId, items, usage, elapsedMs, ... }

await runtime.interrupt(result.threadId);  // cancel an active turn
await runtime.quiesce(result.threadId);    // confirm the turn/session is fully stopped
await runtime.retire(result.threadId);     // release the session (falls back to local-only retirement)
await runtime.close();                     // terminate the subprocess
```

Events: `runtime.on('ready'|'lost'|'diagnostic'|'notification'|'request'|'activity', ...)`.
`'request'` fires for subprocess-initiated JSON-RPC requests (Codex approval/
elicitation prompts, Copilot `session/request_permission`) - see
[Permission policy](#permission-policy) below for how these get answered.
`'activity'` fires a backend-neutral event for every tool/command the agent
runs - see [Activity events](#activity-events) below.

## Activity events

Both adapters normalize command/tool execution into one backend-neutral
`activity` event shape, so a consuming app never has to parse raw Codex
`item/started`/`item/completed` notifications or ACP `tool_call`/
`tool_call_update` notifications directly:

```js
runtime.on('activity', event => { /* ... */ });
// { runtime: 'codex'|'copilot', sessionId, turnId, id, kind, status,
//   title, command, startedAt, endedAt, raw }
```

- `kind` is normalized to one of `command`, `file`, `search`, `fetch`,
  `think`, `tool`, `other` (see `src/activity.mjs`).
- `status` is normalized to `started`, `completed`, or `failed`. Codex emits
  one `item/started` and one `item/completed`; ACP emits one `tool_call`
  (creation) followed by zero or more `tool_call_update` messages for the
  same `toolCallId` - both adapters correlate by id internally and emit the
  same two-or-three-event stream (`started` then `completed`/`failed`).
- `raw` is the untouched backend notification payload, kept as an escape
  hatch for callers that need backend-specific detail beyond the normalized
  fields.

## Permission policy

Every subprocess-initiated permission/approval request (Codex's
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, confirmation-shaped `mcpServer/elicitation/request`;
Copilot's `session/request_permission`) is normalized into one shape and can
be answered with one policy function instead of separate backend-specific code:

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
1. An explicit `runtime.on('request', ...)` listener - if any listener is
   attached, floe-runtime never auto-answers *any* request; the caller has
   full manual control via `runtime.respond()`/`runtime.respondError()`.
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

Not every request type Codex or ACP can send is recognized as a permission
request: real data-form `mcpServer/elicitation/request` payloads (ones with
actual required fields, not a plain yes/no confirmation) return `null` from
`normalizePermissionRequest()` because no generic policy can fabricate real
typed answers - those remain available only via the `'request'` event for
manual handling (subject to the same unhandled-request timeout).

## Schema ownership

floe-runtime ships only the validation *mechanism* (`validate`,
`extractStructuredOutput`, `promptInstructionFor` in `src/schema.mjs`). Each
consuming app defines its own per-role JSON Schemas and prompt templates and
passes the finished `{ prompt, schema }` into `run()`. Codex can enforce
`schema` server-side (`outputSchema` on `turn/start`); Copilot/ACP cannot, so
its prompt text should itself ask for JSON matching the schema (see
`promptInstructionFor(schema)`), with the same client-side validation path
used for both backends.

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

Spawns `copilot --acp` and drives the Agent Client Protocol
(https://agentclientprotocol.com): `initialize` -> `session/new` ->
`session/prompt` (+ `session/update` notifications) -> response with a
`stopReason`. Key differences from Codex, confirmed against the ACP spec:

- **No server-enforced structured output.** The prompt text must itself
  request JSON; the reply is parsed/validated client-side only.
- **`session/load` replays the entire conversation history** back as
  `session/update` notifications - it is not a cheap resume. This adapter's
  default reuse policy therefore keeps sessions alive only **in memory** for
  the life of the subprocess; `session/load` is exposed separately via
  `runtime.resume(sessionId, cwd)` for optional cold-start recovery only, and
  is never called automatically inside `run()`.
- **Permission requests** (`session/request_permission`) are normalized into
  the same backend-neutral shape Codex's approval requests use - see
  [Permission policy](#permission-policy). ACP's option kinds (`allow_once`,
  `allow_always`, `reject_once`, `reject_always`) map 1:1 onto the shared
  decision vocabulary.
- **Session reuse key omits `permissions`.** Unlike Codex's `sessionKey`,
  which hashes in `settings.permissions`, Copilot's key passes `permissions:
  null` deliberately: ACP has no session-scoped permission profile (`session/new`
  takes no approval/sandbox params - every tool call is approved individually
  via `session/request_permission`), so there is no backend permission
  *state* for the key to capture. If a caller's `permissionPolicy` itself has
  meaningfully different versions that should force a fresh session, fold
  that identity into the `settings` argument, which **is** hashed into the
  key - `permissionPolicy` is a runtime-level constructor option floe-runtime
  cannot inspect. See the comment on `sessionKey()` in `src/adapters/copilot.mjs#run()`.
- **`quiesce()`** interrupts (`session/cancel`) and waits for the turn to
  settle; ACP has no background-terminal enumeration equivalent to Codex's,
  so quiescence there is confirmed only at the turn level.
- **`retire()`** calls `session/close` only if the agent advertises
  `agentCapabilities.sessionCapabilities.close` (confirmed live: there is no
  `delete` key, and `session/delete` itself does not exist on the wire -
  it returns JSON-RPC error `-32601 Method not found`); otherwise it retires
  the session locally, same fallback shape as the Codex adapter.
- **Model selection requires an explicit follow-up call.** `session/new`
  silently ignores a `model` param (confirmed live: the returned
  `currentModelId` does not change) - `run()` therefore calls
  `session/set_model` itself whenever the requested model differs from the
  session's tracked current model, on both fresh and reused sessions. Its
  result shape is also a wrapper object (`models: { availableModels: [...],
  currentModelId }`), not a bare array - `models()` normalizes this.
- **Most of Copilot's control surface (permissions, autopilot goals,
  compaction, usage) is exposed only as advertised slash commands**, sent as
  ordinary `session/prompt` text, not as JSON-RPC methods - see
  `available_commands_update` and [Parity surface](#parity-surface) below.

## Parity surface

Both adapters implement the same additional methods beyond the core `run`/
`interrupt`/`quiesce`/`retire`/`close` lifecycle. Where a backend has no
equivalent capability, the method throws a `RuntimeFault` with code
`capability_unsupported` rather than silently no-op'ing - always check
`runtime.capabilities()` first if a call is conditional.

| Method | Codex | Copilot | Notes |
| --- | --- | --- | --- |
| `setModel(id, modelId)` | ✅ (override applied on next `turn/start` - no confirmed live mid-thread RPC) | ✅ `session/set_model` | |
| `releaseSession(id)` / `retire(id)` | ✅ `thread/unsubscribe` | ✅ `session/close` | |
| `setMode(id, mode)` | ❌ unsupported | ✅ `session/set_mode` (`interactive`\|`plan`\|`autopilot` -> ACP mode URIs) | Codex has no session-mode concept |
| `setPermissions(id, level)` | ✅ `approvalPolicy`/`sandbox`/`sandboxPolicy` override, applied next `turn/start` | ✅ `/allow-all`, `/permissions default` (`'read-only'` unsupported - no deny-by-default control command exists) | |
| `setGoal(id, objective, opts)` | ✅ `thread/goal/set`\|`get`\|`clear` (`opts.maxCredits` unsupported - throws) | ✅ `/autopilot <objective> --max-ai-credits <N>` | `opts.maxCredits` is Copilot-only |
| `compact(id, focus)` | ✅ `thread/compact/start` | ✅ `/compact [focus]` | |
| `usage(id)` | ✅ `account/usage/read` + `account/rateLimits/read` | ✅ primary: structured `usage_update` notification; falls back to `/usage` text parsing only if no structured update has arrived | Structured push data wins - regex-parsing prose is a last resort, not the main path |
| `steer(id, text)` | ✅ `turn/steer` (requires an active turn) | ❌ unsupported | ACP has no way to redirect a running prompt |
| `fork(id)` | ✅ `thread/fork` | ✅ `session/fork` | |
| `listSessions()` | ✅ `thread/list` | ✅ `session/list` | |
| `resume(id)` | ✅ `thread/resume` | ✅ `session/load` (full history replay, not a cheap resume) | |
| streaming (`'stream'` event) | ✅ `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta` | ✅ `agent_message_chunk`, tool-call content deltas | |
| rich prompt input (`input.blocks`) | ✅ passed straight through to `turn/start` | ✅ passed straight through to `session/prompt` | floe-runtime does not translate block shapes between backends |
| `availableCommands(id)` | ❌ unsupported | ✅ tracked from `available_commands_update` | |

Call `runtime.capabilities()` to get this table as data:

```js
runtime.capabilities();
// { setModel, releaseSession, setMode, setPermissions, setGoal, compact,
//   usage, steer, fork, listSessions, resume, streaming, richPrompt,
//   availableCommands }
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
  sessions are always resumable via `session/load` (`loadSession` capability
  permitting).
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
  diagnostic - resume() does not fail outright over this, since the
  conversation itself is still perfectly usable, but silently continuing with
  a cleared objective is exactly the bug this closes. Copilot's `resume()`
  accepts the same `{ goal }` option for API symmetry, though whether
  `session/load` has the same goal-loss behaviour is unconfirmed.

## Distinguishing "out of money" from a crash

A backend hitting its own spend/quota wall must never look like a generic
task failure - an unattended overnight run should never leave you debugging
a phantom bug when the real answer is a billing limit.

- **Codex (confirmed live)**: a spend-cap turn arrives as an ordinary
  `turn/completed` with `turn.status === 'failed'` and
  `turn.error.codexErrorInfo === 'usageLimitExceeded'`. This is detected and
  raised as a distinct `usage_limit_exceeded` `RuntimeFault` (not the generic
  `turn_failed`), carrying the backend's own human-readable message.
- **Copilot (UNCONFIRMED heuristic)**: the exact ACP shape for a quota/limit
  refusal could not be confirmed without live access. As a best-effort,
  clearly-marked extension point, a `stopReason: 'refusal'` whose accumulated
  message text matches quota/credit/spend-cap language also raises
  `usage_limit_exceeded` - see `looksLikeUsageLimit()` in
  `src/adapters/copilot.mjs`. Replace this the moment the real shape is
  observed live.
- **One consistent signal regardless of source**: a backend-reported
  `usage_limit_exceeded` publishes the SAME `'budgetCeilingReached'` event
  type a `Fleet`'s own configured budget ceiling uses (see below), tagged
  `source: 'backend'`. An app therefore has exactly one way to learn "the
  fleet stopped for money reasons," whether the fleet's own ceiling or the
  backend's own billing limit tripped first - `Fleet` wires this in even when
  no `budget.ceiling` was ever configured.

## Other Codex notifications now surfaced (not silently dropped)

Confirmed arriving from the real `codex app-server` and previously ignored
entirely:

- `account/rateLimits/updated` - the early warning before a spend-cap wall.
  Folded into the same `'usage'` event type the budget/Fleet surface already
  watches (not a new event type).
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
- `replay` - `true` while the event is part of replayed history (e.g. Codex's
  synthetic post-`resume()` snapshot, or Copilot's `session/load` notification
  burst), `false` once activity is live. A `'replayComplete'` event marks the
  transition.
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
| Copilot | Yes | Yes - `fleet.setGoal()` auto-injects the fleet's remaining budget as Copilot's own `/autopilot --max-ai-credits` second line of defence, unless you pass `maxCredits` explicitly |
| Codex | Yes | No - Codex has no credit cap of any kind; measurement + fleet-level admission control is all that's possible |

Spend is aggregated as **latest known cost per agent**, summed - never as a
running total of raw usage-event deltas, because both backends' usage
notifications report a session's cumulative cost-to-date, not a per-event
increment (double-counting them would over-report spend).

A backend can also report its OWN spend/quota wall independently of
`Fleet`'s configured `ceiling` (Codex's confirmed `usageLimitExceeded`, or
Copilot's best-effort refusal heuristic - see "Distinguishing 'out of money'
from a crash" above). That trips the exact same admission-control gate:
`Fleet` emits `'budgetCeilingReached'` (tagged `source: 'backend'`), marks
`budget.exceeded`, and rejects queued work - even if no `ceiling` was ever
configured. One event, one meaning, regardless of which side noticed the
wall first.

### Concurrency and queueing

`maxConcurrentTurns` bounds fleet-wide in-flight turns; excess `run()` calls
queue FIFO, with `run(agentId, input, onStart, settings, { priority })`
letting an urgent agent jump the queue. `Fleet` emits `'queueDepth'` (depth +
active-turn count) and `'admission'` events so an app can show what's
waiting and why. The queue drains only from turn-settlement/shard-loss/agent-
retirement events - never a timer (see "No polling, anywhere").

### Two different swarm shapes: `/fleet` vs. Fleet-of-sessions

Copilot's own `/fleet` control command (`fleet.fleetMode(agentId, prompt)`)
fans out parallel **subagents inside one session** - a different shape from
this `Fleet` class's pool of independent sessions:

- Use Copilot's `/fleet` for a short parallel burst that shares one context
  (one conversation, several subagents working on parts of it at once).
- Use this `Fleet` class for long-lived, independent agents with separate
  conversations, potentially spanning both backends.

Codex has no equivalent to Copilot's `/fleet` - `fleetMode()` is `unsupported`
on Codex agents.

### Backend-side scheduling

Copilot also advertises `/every <interval> <prompt>` (recurring) and
`/after <delay> <prompt>` (one-shot), exposed as `fleet.scheduleRecurring()`
and `fleet.scheduleOnce()`. **These are backend-side timers** - the Copilot
CLI process schedules and wakes itself; floe-runtime is not polling anything
to support this, and this does not relax the no-polling rule anywhere else in
the codebase. Codex has no equivalent - both methods are `unsupported` on
Codex agents.

## Prompt text is executed verbatim

Prompt text (and Copilot's advertised slash commands, sent as ordinary prompt
text) is passed to the backend **exactly as given - never sanitized,
escaped, or filtered**. floe-runtime is a gateway: it must behave exactly as
if the user had typed into the CLI themselves. If your app composes prompts
programmatically (e.g. concatenating user input), you are responsible for
whatever that produces - including accidentally triggering a control command.

Two concrete gotchas to design around:

- On Copilot, a bare `/goal` does **not** print help text - it immediately
  switches the session into autopilot mode. Any leading `/` in prompt text is
  live control-command syntax, not a plain message.
- `availableCommands()` (P14, backed by the `available_commands_update`
  notification) is a **UI hint only, not authoritative**. Confirmed: `/goal`
  works over ACP despite never appearing in `available_commands_update`.
  Never gate whether you allow/attempt a command on whether it was
  advertised - the advertised list can be incomplete.

## Shared modules

- `src/runtime.mjs` - base `Runtime` class: subprocess lifecycle, start()
  dedup, `ready`/`lost`/`diagnostic`/`notification`/`request` event wiring.
  Adapters implement `handshake()`, `onNotification()`, `onRequest()`,
  `onLost()`, `onClosing()`.
- `src/jsonrpc.mjs` - `JsonRpcPeer`: newline-delimited JSON-RPC framing over
  a child process's stdio, request/response correlation, timeouts.
- `src/session-reuse.mjs` - `sessionKey()` (digest of role/cwd/model/settings/
  permissions/scope) and `SessionRegistry` (tracks known sessions and their
  confirmed-stopped state, the precondition for reuse and retirement).
- `src/schema.mjs` - `validate()` (small JSON-Schema-subset validator),
  `extractStructuredOutput()`, `promptInstructionFor()`.
- `src/activity.mjs` - the normalized activity event shape and each backend's
  `kind` mapping (`codexActivityKind()`, `acpActivityKind()`).
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

Runs `node --test` against `test/*.test.mjs`, using `test/fake-codex.mjs` and
`test/fake-copilot.mjs` - small stdin/stdout fixture scripts that speak just
enough of each protocol to exercise start/run/interrupt/quiesce/retire/reuse,
with no live network calls or real CLI installs required. `test/fleet.test.mjs`
exercises `Fleet` (shard saturation/queueing, crash recovery for persistent
vs. ephemeral agents, budget-ceiling admission control, event-driven queue
draining) against the same two fixtures - no additional fixture protocol was
needed beyond a `debug/crash` hook that exits the fixture process on demand.

## Smoke tests (real binaries, real cost)

```
npm run smoke
```

Runs `node --test` against `test-smoke/*.smoke.test.mjs` - a small, SEPARATE
suite that spawns the REAL installed `codex`/`copilot` binaries. `npm test`
never runs these; they are not fake-based, they cost real API credits, and
they take real wall-clock time (multiple real process spawns and model
turns). See `test-smoke/README.md` for full details.

Each test probes for its binary/authentication first and skips cleanly (with
an explicit reason) rather than failing when it is unavailable. As of this
writing, Codex's smoke coverage skips with `Codex unavailable: spend cap
reached` - the workspace this was developed against has exhausted its spend
cap until an October 1st reset - which is itself a live confirmation of the
`usage_limit_exceeded` fault detection above, not a bug in the suite.

The most important scenario is resume-across-real-process-death: plant a
codeword via a real turn, `SIGKILL` the real subprocess (not a graceful
`close()`), start a brand-new runtime instance, `resume()` the session, and
confirm the agent still recalls the codeword - while asserting replayed
history is correctly flagged `replay: true` and never mistaken for live
activity. This is currently verified working against the real Copilot
binary; the identical Codex test is written and ready, pending the spend cap
reset.

