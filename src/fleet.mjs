// Fleet: the substrate for running many agents (across BOTH backends) at once.
//
// Scope boundary (deliberate): Fleet owns pooling, process isolation, spend limits, concurrency
// control and a uniform event stream. It does NOT own orchestration policy - who does what, task
// dependency ordering, routing, or result aggregation. Consuming apps (star-map, floe) own that; they
// must keep their own orchestration and simply ask this Fleet for agent handles to run turns on. This
// is not a task graph, not a scheduler of work items, and not an agent-to-agent message bus.
//
// "Unbounded" agents, bounded execution: requestAgent() always succeeds immediately and is never
// capped - you can register as many agent handles as you want. Actually RUNNING a turn is bounded by
// sharding (maxSessionsPerProcess/maxProcesses - how many backend subprocesses exist and how many
// sessions live on each) and concurrency (maxConcurrentTurns - how many turns may be in flight across
// the whole fleet at once). When a limit is reached, new work QUEUES (FIFO, optional priority) rather
// than spawning without bound or thrashing the host machine. The queue drains purely from push events
// (a turn settling, an agent retiring) - never from a timer or a retry loop (see README's "No polling"
// section, which this module fully respects).
//
// No daemon, no IPC layer, no transport abstraction: a Fleet is an in-process object your app
// constructs and owns, exactly like a single Runtime - it just manages several of them.
import { EventEmitter } from 'node:events';
import { RuntimeFault, id } from './errors.mjs';
import { EventLog, watchEvents } from './events.mjs';

const SETTLED_PHASES = new Set(['completed', 'interrupted', 'failed']);
const DEFAULT_WARN_AT = Object.freeze([0.5, 0.8]);

export class Fleet extends EventEmitter {
  /**
   * @param {{
   *   backends: Record<string, () => import('./runtime.mjs').Runtime>, // e.g. { copilot: () => new CopilotRuntime(...), codex: () => new CodexRuntime(...) }
   *   defaultBackend?: string,       // Copilot is first-call by long-standing user requirement; Codex stays fully selectable per agent/role - not a replacement.
   *   maxSessionsPerProcess?: number, // sessions (agents) sharing one subprocess/stdio pipe before a new one is opened
   *   maxProcesses?: number,          // hard cap on subprocesses per backend; Infinity means "as many shards as sessions require"
   *   maxConcurrentTurns?: number,    // fleet-wide in-flight turn cap
   *   autoRecover?: boolean,          // re-establish persistent agents on a fresh shard after a shard dies (see #handleShardLost)
   *   budget?: { ceiling?: number, warnAt?: number[], interruptOnCeiling?: boolean },
   *   replayBufferSize?: number,
   * }} options
   */
  constructor({
    backends = {}, defaultBackend = 'copilot', maxSessionsPerProcess = 8, maxProcesses = Infinity,
    maxConcurrentTurns = Infinity, autoRecover = true, budget = {}, replayBufferSize,
  } = {}) {
    super();
    this.backendFactories = backends;
    this.defaultBackend = defaultBackend;
    this.maxSessionsPerProcess = maxSessionsPerProcess;
    this.maxProcesses = maxProcesses;
    this.maxConcurrentTurns = maxConcurrentTurns;
    this.autoRecover = autoRecover;
    this.budget = {
      ceiling: budget.ceiling ?? null,
      warnAt: budget.warnAt ?? DEFAULT_WARN_AT,
      interruptOnCeiling: budget.interruptOnCeiling ?? false,
      spent: 0,
      exceeded: false,
      warned: new Set(),
    };
    this.agents = new Map(); // agentId -> AgentRecord
    this.shards = new Map(); // shardId -> Shard
    this.shardLists = new Map(); // backend -> Shard[]
    this.queue = []; // pending run() admissions: {agentId, input, onStart, settings, priority, enqueuedAt, resolve, reject}
    this.activeTurns = 0;
    // S1: a stable capability view per backend for a MIXED fleet, without spawning a subprocess just to
    // ask - capabilities() is a pure, synchronous, no-IO method on every Runtime.
    this.backendCapabilities = {};
    for (const [backend, factory] of Object.entries(this.backendFactories)) {
      this.backendCapabilities[backend] = factory().capabilities();
    }
    // Reuses the same envelope shape/semantics (seq, replay, gap) as a single Runtime - see src/events.mjs.
    // Fleet re-publishes every shard's events under the requesting agent's stable id as conversationId,
    // so a consumer never needs to know which physical process/session an agent lives on.
    this.eventLog = new EventLog(replayBufferSize);
  }

  /** Registers a durable agent handle. Never blocks and never fails due to capacity - assignment onto an
   * actual backend subprocess/session is deferred to the first run() call (see #drain/#acquireShard). */
  requestAgent({ role, cwd, model, backend = this.defaultBackend, scope, ephemeral = false, priority = 0 } = {}) {
    if (!this.backendFactories[backend]) throw new RuntimeFault('backend_unknown', `Fleet has no factory registered for backend '${backend}'.`, 400);
    const agentId = id('agent');
    this.agents.set(agentId, {
      id: agentId, role, cwd, model, backend, scope, ephemeral, priority,
      status: 'unassigned', shardId: null, sessionId: null, lastUsage: null, lastGoal: null,
    });
    return agentId;
  }

  /** Read-only view of one agent's bookkeeping (status/backend/shard/sessionId) - never the live Runtime. */
  agent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return { id: agent.id, role: agent.role, cwd: agent.cwd, model: agent.model, backend: agent.backend, status: agent.status, sessionId: agent.sessionId };
  }

  /** S1: the capability view for one backend (or, given an agentId, that agent's backend) - lets a
   * caller check before calling a parity method on a MIXED fleet instead of discovering it via a thrown
   * capability_unsupported fault. Never silently degrades - unsupported methods still throw when called. */
  capabilities(backendOrAgentId) {
    if (this.backendCapabilities[backendOrAgentId]) return this.backendCapabilities[backendOrAgentId];
    const agent = this.agents.get(backendOrAgentId);
    if (agent) return this.backendCapabilities[agent.backend];
    throw new RuntimeFault('agent_unknown', `'${backendOrAgentId}' is neither a registered backend nor a known agent id.`, 404);
  }

  /** Every registered backend's capability map at once, for a full mixed-fleet picture. */
  capabilitiesByBackend() {
    return { ...this.backendCapabilities };
  }

  /**
   * Runs one turn for `agentId`. Always admission-controlled: queues (FIFO, `options.priority` breaks
   * ties in favour of higher priority) if the fleet is at its concurrency limit, if this agent's backend
   * has no free shard capacity and is at maxProcesses, or resolves immediately to a rejection if the
   * fleet's spend ceiling has already been reached (S3: admission control, not mere observation).
   */
  run(agentId, input, onStart = () => {}, settings = {}, options = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new RuntimeFault('agent_unknown', `No agent registered with id ${agentId}.`, 404));
    if (agent.status === 'lost') return Promise.reject(new RuntimeFault('agent_lost', `Agent ${agentId} is permanently lost (its shard died and it could not be recovered) and cannot run further turns.`, 410));
    if (this.budget.exceeded) return Promise.reject(new RuntimeFault('budget_exceeded', 'The fleet budget ceiling has been reached; no new turns are admitted.', 429));
    return new Promise((resolve, reject) => {
      this.queue.push({ agentId, input, onStart, settings, priority: options.priority ?? agent.priority ?? 0, enqueuedAt: Date.now(), resolve, reject });
      this.#emitQueueDepth();
      this.#drain();
    });
  }

  async interrupt(agentId) {
    const { agent, shard } = this.#located(agentId);
    if (!shard || !agent.sessionId) return undefined;
    return shard.runtime.interrupt(agent.sessionId);
  }

  async quiesce(agentId) {
    const { agent, shard } = this.#located(agentId);
    if (!shard || !agent.sessionId) return undefined;
    return shard.runtime.quiesce(agent.sessionId);
  }

  /** Releases the agent's backend session (if any) and forgets the handle. This is the ONLY thing that
   * ends an agent's conversation - see the README's conversation-lifetime contract, which applies here
   * exactly as it does to a bare Runtime. */
  async retireAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return { status: 'unavailable' };
    let result = { status: 'retired' };
    if (agent.shardId) {
      const shard = this.shards.get(agent.shardId);
      if (shard && agent.sessionId) {
        await shard.runtime.quiesce(agent.sessionId); // confirms the session actually stopped - retire() requires this
        result = await shard.runtime.retire(agent.sessionId);
      }
      shard?.agentIds.delete(agentId);
      if (agent.sessionId) shard?.sessionToAgent.delete(agent.sessionId);
    }
    agent.status = 'retired';
    this.agents.delete(agentId);
    this.eventLog.clear(agentId);
    this.#drain(); // retiring an agent may have freed a shard slot for queued work
    return result;
  }

  /** S3: sets/clears an autopilot objective for one agent. On Copilot, when a fleet-wide budget ceiling
   * is configured and the caller did not specify opts.maxCredits, this injects the fleet's REMAINING
   * budget as a second line of defence enforced by the backend itself, in addition to fleet-level
   * admission control (S3's Copilot bullet) - Codex has no such backend enforcement, see capabilities(). */
  async setGoal(agentId, objective, opts = {}) {
    const { agent, shard } = this.#located(agentId);
    this.#requireShard(agentId, shard);
    let finalOpts = opts;
    if (agent.backend === 'copilot' && this.budget.ceiling != null && opts.maxCredits == null) {
      finalOpts = { ...opts, maxCredits: Math.max(0, this.budget.ceiling - this.budget.spent) };
    }
    const result = await shard.runtime.setGoal(agent.sessionId, objective, finalOpts);
    // F11: remembered so a shard crash recovery (see #recoverAgent) can re-apply this goal on the FRESH
    // runtime instance that recovers the agent - that instance has no in-memory history of its own.
    agent.lastGoal = objective;
    return result;
  }

  setModel(agentId, modelId) { return this.#delegate(agentId, 'setModel', modelId); }

  setPermissions(agentId, level) { return this.#delegate(agentId, 'setPermissions', level); }

  compact(agentId, focus) { return this.#delegate(agentId, 'compact', focus); }

  usage(agentId) { return this.#delegate(agentId, 'usage'); }

  fork(agentId) { return this.#delegate(agentId, 'fork'); }

  /** S5: Copilot's single-session parallel-subagent fan-out (/fleet) - a DIFFERENT shape from this
   * Fleet's own pool-of-sessions model. See the README for when to use which. Unsupported on Codex. */
  fleetMode(agentId, prompt) { return this.#delegate(agentId, 'fleetMode', prompt); }

  /** S6: backend-side scheduling (Copilot's /every, /after) - the backend wakes itself; not polling. */
  scheduleRecurring(agentId, interval, prompt) { return this.#delegate(agentId, 'scheduleRecurring', interval, prompt); }

  scheduleOnce(agentId, delay, prompt) { return this.#delegate(agentId, 'scheduleOnce', delay, prompt); }

  /** S1: the unified event stream for ONE agent, reusing the exact same replay/gap/seq semantics a bare
   * Runtime gives you (see src/events.mjs) - Fleet exposes the same shape (`eventLog`, `on('event')`,
   * `once('lost')`) so watchEvents() works unmodified. */
  events(agentId, options) {
    return watchEvents(this, agentId, options);
  }

  /** Publishes one fleet-level event for `agentId` - every envelope also fires on the fleet-wide
   * unified `'event'` stream (S1's "ONE unified event stream for the whole fleet"). */
  publish(agentId, type, data, opts = {}) {
    const envelope = this.eventLog.publish(agentId, type, data, opts);
    this.emit('event', envelope);
    this.emit(type, data);
    return envelope;
  }

  /** Current fleet-wide spend/queue/concurrency snapshot, useful for a dashboard. */
  status() {
    return {
      agents: this.agents.size,
      shards: this.shards.size,
      activeTurns: this.activeTurns,
      queueDepth: this.queue.length,
      budget: { ceiling: this.budget.ceiling, spent: this.budget.spent, exceeded: this.budget.exceeded },
    };
  }

  async close() {
    for (const entry of this.queue.splice(0, this.queue.length)) {
      entry.reject(new RuntimeFault('fleet_closing', 'The fleet was closed while this turn was still queued.', 503));
    }
    for (const shard of this.shards.values()) await shard.runtime.close().catch(() => {});
    this.shards.clear();
    this.shardLists.clear();
  }

  // -- internals -------------------------------------------------------------------------------------

  #located(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new RuntimeFault('agent_unknown', `No agent registered with id ${agentId}.`, 404);
    const shard = agent.shardId ? this.shards.get(agent.shardId) : null;
    return { agent, shard };
  }

  #requireShard(agentId, shard) {
    if (!shard) throw new RuntimeFault('agent_not_started', `Agent ${agentId} has not run a turn yet, so it has no live session.`, 409);
  }

  async #delegate(agentId, method, ...args) {
    const { agent, shard } = this.#located(agentId);
    this.#requireShard(agentId, shard);
    return shard.runtime[method](agent.sessionId, ...args);
  }

  #shardList(backend) {
    let list = this.shardLists.get(backend);
    if (!list) { list = []; this.shardLists.set(backend, list); }
    return list;
  }

  /** Non-mutating capacity check used while picking the next queue entry to admit. */
  #canAssign(agent) {
    if (agent.shardId) return true;
    const list = this.#shardList(agent.backend);
    if (list.some(shard => shard.agentIds.size < this.maxSessionsPerProcess)) return true;
    return list.length < this.maxProcesses;
  }

  /** Mutating: assigns (or spawns, within maxProcesses) a shard for `agent`, or returns null if the
   * backend is fully saturated (every shard at maxSessionsPerProcess and maxProcesses reached) - the
   * caller must leave the request queued rather than spawn without bound. */
  #acquireShard(agent) {
    if (agent.shardId) return this.shards.get(agent.shardId);
    const list = this.#shardList(agent.backend);
    let shard = list.find(candidate => candidate.agentIds.size < this.maxSessionsPerProcess);
    if (!shard) {
      if (list.length >= this.maxProcesses) return null;
      shard = this.#createShard(agent.backend);
    }
    shard.agentIds.add(agent.id);
    agent.shardId = shard.id;
    return shard;
  }

  #createShard(backend) {
    const factory = this.backendFactories[backend];
    if (!factory) throw new RuntimeFault('backend_unknown', `Fleet has no factory registered for backend '${backend}'.`, 400);
    const shard = { id: id('shard'), backend, runtime: factory(), agentIds: new Set(), sessionToAgent: new Map() };
    this.shards.set(shard.id, shard);
    this.#shardList(backend).push(shard);
    this.#wireShard(shard);
    return shard;
  }

  #wireShard(shard) {
    shard.runtime.on('event', envelope => {
      const agentId = shard.sessionToAgent.get(envelope.conversationId);
      if (!agentId) return; // an event for a session this fleet hasn't attributed to an agent yet
      const agent = this.agents.get(agentId);
      if (!agent) return;
      if (envelope.type === 'usage') this.#recordUsage(agent, envelope.data);
      this.publish(agentId, envelope.type, { ...envelope.data, agentId, backend: shard.backend }, { replay: envelope.replay });
      // F9: a backend can report its OWN spend/quota wall (Codex's usageLimitExceeded turn error,
      // Copilot's best-effort refusal heuristic) independently of our own configured ceiling. Route it
      // through the same admission-control path as #recalculateBudget() so "stopped for money reasons"
      // means one thing regardless of which side noticed first.
      if (envelope.type === 'budgetCeilingReached' && envelope.data.source === 'backend') this.#handleBackendCeiling(agent, envelope.data);
      // PART 1 rule still applies here: the queue drains from this push event (a turn settling), never
      // from a timer or retry loop.
      if (envelope.type === 'turn' && SETTLED_PHASES.has(envelope.data.phase)) this.#drain();
    });
    shard.runtime.on('lost', error => this.#handleShardLost(shard, error));
  }

  #recordUsage(agent, data) {
    agent.lastUsage = { cost: typeof data.cost === 'number' ? data.cost : agent.lastUsage?.cost || 0 };
    this.#recalculateBudget();
  }

  #recalculateBudget() {
    if (this.budget.ceiling == null) return;
    let spent = 0;
    for (const agent of this.agents.values()) spent += agent.lastUsage?.cost || 0;
    this.budget.spent = spent;
    this.emit('spend', { spent, ceiling: this.budget.ceiling });
    for (const pct of this.budget.warnAt) {
      if (!this.budget.warned.has(pct) && spent >= this.budget.ceiling * pct) {
        this.budget.warned.add(pct);
        this.emit('budgetWarning', { pct, spent, ceiling: this.budget.ceiling });
      }
    }
    if (!this.budget.exceeded && spent >= this.budget.ceiling) {
      this.budget.exceeded = true;
      // Distinct from a normal drained-empty queue, so an app can tell "the swarm finished" apart from
      // "the swarm ran out of budget" (S3's explicit usability requirement).
      this.emit('budgetCeilingReached', { spent, ceiling: this.budget.ceiling });
      const rejected = this.queue.splice(0, this.queue.length);
      for (const entry of rejected) entry.reject(new RuntimeFault('budget_exceeded', 'The fleet budget ceiling was reached; this queued turn was cancelled before it started.', 429));
      this.#emitQueueDepth();
      if (this.budget.interruptOnCeiling) {
        for (const agent of this.agents.values()) {
          if (!agent.sessionId || !agent.shardId) continue;
          this.shards.get(agent.shardId)?.runtime.interrupt(agent.sessionId).catch(() => {});
        }
      }
    }
  }

  /** F9: a backend itself reported hitting a spend/quota wall (agent-level, source: 'backend') - trips
   * the SAME admission-control gate #recalculateBudget() trips for our own ceiling, so a caller has
   * exactly one way to learn "the fleet stopped for money reasons" no matter which side noticed first.
   * Works even when this.budget.ceiling was never configured. */
  #handleBackendCeiling(agent, data) {
    if (this.budget.exceeded) return;
    this.budget.exceeded = true;
    this.emit('budgetCeilingReached', { spent: this.budget.spent, ceiling: this.budget.ceiling, source: 'backend', agentId: agent.id, backend: agent.backend, reason: data.reason });
    const rejected = this.queue.splice(0, this.queue.length);
    for (const entry of rejected) entry.reject(new RuntimeFault('budget_exceeded', 'A backend reported hitting its own spend/quota limit; this queued turn was cancelled before it started.', 429));
    this.#emitQueueDepth();
  }

  #handleShardLost(shard, error) {
    const affected = [...shard.agentIds];
    // Untrack the dead shard FIRST - it must never be reused as an assignment target while agents are
    // being recovered below, and it must not linger in this.shards where close() would (uselessly) try
    // to terminate an already-dead process while a freshly spawned replacement goes untracked/unterminated.
    const list = this.#shardList(shard.backend);
    const index = list.indexOf(shard);
    if (index !== -1) list.splice(index, 1);
    this.shards.delete(shard.id);
    this.emit('shardLost', { shardId: shard.id, backend: shard.backend, agentIds: affected, reason: error?.message || 'unknown' });
    for (const agentId of affected) {
      const agent = this.agents.get(agentId);
      shard.agentIds.delete(agentId);
      if (!agent) continue;
      if (agent.ephemeral) {
        agent.status = 'lost';
        this.publish(agentId, 'agentLost', { agentId, backend: agent.backend, recoverable: false, reason: 'The shard process died and this agent opted out of persistence (ephemeral:true); it has no conversation to recover.' });
        continue;
      }
      if (!this.autoRecover) {
        agent.status = 'lost';
        this.publish(agentId, 'agentLost', { agentId, backend: agent.backend, recoverable: true, reason: 'The shard process died; autoRecover is disabled so this agent was not automatically re-established.' });
        continue;
      }
      agent.status = 'recovering';
      agent.shardId = null;
      this.publish(agentId, 'agentRecovering', { agentId, backend: agent.backend });
      this.#recoverAgent(agent);
    }
    this.#drain(); // a dead shard may unblock queued admissions waiting on maxProcesses
  }

  async #recoverAgent(agent) {
    try {
      const newShard = this.#acquireShard(agent);
      if (!newShard) { agent.status = 'lost'; this.publish(agent.id, 'agentLost', { agentId: agent.id, backend: agent.backend, recoverable: true, reason: 'No shard capacity was available to recover this agent (maxProcesses reached).' }); return; }
      await newShard.runtime.start();
      // Map the PRE-resume sessionId to this agent BEFORE awaiting resume() - resume() itself publishes
      // events (replay, goalReapplied/goalReapplyFailed, replayComplete) synchronously under that id
      // while the promise is still in flight, and #wireShard would silently drop every one of them
      // without a mapping in place yet.
      newShard.sessionToAgent.set(agent.sessionId, agent.id);
      const resumedId = agent.backend === 'codex'
        ? await newShard.runtime.resume(agent.sessionId, { goal: agent.lastGoal ?? undefined })
        : await newShard.runtime.resume(agent.sessionId, agent.cwd, [], { goal: agent.lastGoal ?? undefined });
      if (resumedId !== agent.sessionId) newShard.sessionToAgent.delete(agent.sessionId);
      agent.sessionId = resumedId;
      newShard.sessionToAgent.set(resumedId, agent.id);
      agent.status = 'ready';
      this.publish(agent.id, 'agentRecovered', { agentId: agent.id, backend: agent.backend, shardId: newShard.id });
      this.#drain();
    } catch (error) {
      agent.status = 'lost';
      this.publish(agent.id, 'agentLost', { agentId: agent.id, backend: agent.backend, recoverable: true, reason: `Automatic recovery failed: ${error.message}` });
    }
  }

  #emitQueueDepth() {
    this.emit('queueDepth', { depth: this.queue.length, activeTurns: this.activeTurns });
  }

  /** Admits as much queued work as current concurrency/shard capacity/budget allow. Called only from
   * push events (queue-and-drain requests, turn settlement, shard loss, agent retirement) - never from a
   * timer (PART 1's no-polling rule applies to Fleet exactly as it does to a bare Runtime). */
  #drain() {
    if (this.budget.exceeded) return;
    for (;;) {
      if (this.activeTurns >= this.maxConcurrentTurns) return;
      let bestIndex = -1;
      for (let i = 0; i < this.queue.length; i += 1) {
        const entry = this.queue[i];
        const agent = this.agents.get(entry.agentId);
        if (!agent || agent.status === 'lost' || agent.status === 'recovering') continue;
        if (!this.#canAssign(agent)) continue;
        if (bestIndex === -1) { bestIndex = i; continue; }
        const best = this.queue[bestIndex];
        if (entry.priority > best.priority || (entry.priority === best.priority && entry.enqueuedAt < best.enqueuedAt)) bestIndex = i;
      }
      if (bestIndex === -1) return;
      const [entry] = this.queue.splice(bestIndex, 1);
      this.#emitQueueDepth();
      this.#admit(entry);
    }
  }

  async #admit(entry) {
    const agent = this.agents.get(entry.agentId);
    const shard = this.#acquireShard(agent);
    this.activeTurns += 1;
    this.emit('admission', { agentId: agent.id, backend: agent.backend, shardId: shard.id, activeTurns: this.activeTurns, queueDepth: this.queue.length });
    try {
      await shard.runtime.start();
      // Each adapter's own session-reuse policy needs a stable `scope` to treat successive run() calls
      // as the SAME conversation rather than always starting fresh - the agent's own durable id is
      // exactly that stable identity, so it doubles as the reuse scope unless the caller overrides it.
      const continuation = { sessionId: agent.sessionId, threadId: agent.sessionId, scope: agent.scope || agent.id };
      const wrappedOnStart = (sessionOrThreadId, meta) => {
        agent.sessionId = sessionOrThreadId;
        agent.status = 'ready';
        shard.sessionToAgent.set(sessionOrThreadId, agent.id);
        return entry.onStart(sessionOrThreadId, meta);
      };
      const result = await shard.runtime.run(
        agent.role, entry.input, agent.cwd, wrappedOnStart,
        { model: agent.model, ephemeral: agent.ephemeral, ...entry.settings }, continuation,
      );
      agent.sessionId = result.sessionId || result.threadId || agent.sessionId;
      // Each adapter's reuse policy only treats a session as reusable once a clean stop is CONFIRMED
      // (see SessionRegistry#isReusable) - a caller repeatedly calling fleet.run() on the same agent
      // must not have to know that, so Fleet confirms it here on every settled turn.
      await shard.runtime.quiesce(agent.sessionId).catch(() => {});
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      this.activeTurns -= 1;
      this.#emitQueueDepth();
      this.#drain();
    }
  }
}
