// Controlled protocol fixture standing in for `codex app-server`, used only
// by this package's own tests. Understands a handful of markers embedded in
// the prompt text (set by the test, not by any app-specific role logic) to
// drive different completion paths:
//   [bad-json]         final agentMessage text is not JSON (schema validation fails)
//   [missing]          final agentMessage text is valid JSON missing a required field
//   [delay]            waits before completing, so a test can interrupt() first
//   [hang]              never completes on its own (only ends via turn/interrupt)
//   [command]           emits an item/started + item/completed commandExecution pair before the report
//   [approval]          sends an item/commandExecution/requestApproval server request before completing
//   [unknown-request]   sends a request type normalizePermissionRequest() does not recognize, to exercise
//                       the last-resort unhandled-request timeout safety net
//   [stream]            emits item/agentMessage/delta, item/reasoning/textDelta and item/commandExecution/outputDelta
//                       notifications before the report, to exercise the normalized 'stream' event (P12)
//   [background-turn]   after completing the client-tracked turn, leaves a synthetic 'stray_1' turn marked
//                       inProgress in the thread's own turn list, to exercise quiesce()'s notification-driven
//                       (not polling) wait for a turn this runtime instance never tracked locally
// Also tracks thread/read call counts (see debug/counters) so a test can assert quiesce() never re-reads
// thread state on a timer (PART 1: no polling anywhere).
import readline from 'node:readline';

let serial = 0;
const threads = new Map();
const timers = new Map();
let threadReadCalls = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });

function reportFor(promptText) {
  if (promptText.includes('[bad-json]')) return 'not json';
  if (promptText.includes('[missing]')) return JSON.stringify({});
  return JSON.stringify({ ok: true, summary: 'Fixture output' });
}

function complete(threadId, turnId, promptText) {
  if (promptText.includes('[usage-limit]')) {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', items: [], error: { message: 'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null } } });
    timers.delete(threadId);
    return;
  }
  const item = { id: 'report_' + turnId, type: 'agentMessage', text: reportFor(promptText), phase: 'final_answer' };
  notify('item/completed', { threadId, turnId, item });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [item], error: null } });
  timers.delete(threadId);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  try {
    const message = JSON.parse(line);
    const params = message.params || {};
    if (message.method === 'initialize') return reply(message.id, { userAgent: 'fake-codex/1.0' });
    if (message.method === 'initialized') return;
    if (message.method === 'model/list') {
      return reply(message.id, { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', isDefault: true }], nextCursor: null });
    }
    if (message.method === 'thread/start') {
      const thread = {
        id: 'thread_' + process.pid + '_' + (++serial), turns: [], status: { type: 'idle' },
        ephemeral: params.ephemeral === true, cwd: params.cwd, model: params.model || 'fixture-model',
        updatedAt: new Date().toISOString(),
      };
      threads.set(thread.id, thread);
      return reply(message.id, { thread, model: thread.model, reasoningEffort: 'medium' });
    }
    if (message.method === 'thread/unsubscribe') {
      const thread = threads.get(params.threadId);
      return reply(message.id, { status: thread ? 'unsubscribed' : 'notLoaded' });
    }
    if (message.method === 'thread/read') {
      threadReadCalls += 1;
      return reply(message.id, { thread: threads.get(params.threadId) || { id: params.threadId, turns: [], status: { type: 'idle' } } });
    }
    if (message.method === 'debug/counters') return reply(message.id, { threadReadCalls });
    if (message.method === 'debug/crash') { process.exit(1); return; } // simulates a shard subprocess dying, for Fleet crash-recovery tests
    // F10: on-demand emission of the five previously-unhandled real Codex notifications, for regression tests.
    if (message.method === 'debug/emit-f10') {
      notify('account/rateLimits/updated', { limit: 100, remaining: 10 });
      notify('error', { message: 'fixture server error' });
      notify('hook/started', { threadId: params.threadId, hook: { id: 'hook_1', name: 'pre-commit' } });
      notify('hook/completed', { threadId: params.threadId, hook: { id: 'hook_1', name: 'pre-commit' } });
      notify('mcpServer/startupStatus/updated', { threadId: params.threadId, server: 'fixture-mcp', status: 'authFailed' });
      notify('thread/settings/updated', { threadId: params.threadId, settings: { sandbox: 'workspace-write' } });
      return reply(message.id, {});
    }
    if (message.method === 'debug/age-thread') {
      const thread = threads.get(params.threadId);
      if (thread) thread.updatedAt = new Date(Date.now() - params.ageMs).toISOString();
      return reply(message.id, {});
    }
    if (message.method === 'thread/backgroundTerminals/list') return reply(message.id, { data: [], nextCursor: null });
    if (message.method === 'thread/backgroundTerminals/terminate') return reply(message.id, { terminated: true });
    if (message.method === 'thread/goal/set') {
      const thread = threads.get(params.threadId);
      if (thread) thread.goal = params.objective;
      return reply(message.id, { objective: params.objective });
    }
    if (message.method === 'thread/goal/get') return reply(message.id, { objective: null });
    if (message.method === 'thread/goal/clear') {
      const thread = threads.get(params.threadId);
      if (thread) thread.goal = null;
      return reply(message.id, {});
    }
    if (message.method === 'thread/compact/start') return reply(message.id, { started: true });
    if (message.method === 'account/usage/read') return reply(message.id, { requests: 5 });
    if (message.method === 'account/rateLimits/read') return reply(message.id, { limit: 100, remaining: 95 });
    if (message.method === 'turn/steer') return reply(message.id, { accepted: true });
    if (message.method === 'thread/fork') return reply(message.id, { thread: { id: 'thread_fork_' + (++serial), turns: [], status: { type: 'idle' } } });
    if (message.method === 'thread/list') return reply(message.id, { data: [...threads.values()], nextCursor: null });
    if (message.method === 'thread/resume') {
      const thread = threads.get(params.threadId) || { id: params.threadId, turns: [], status: { type: 'idle' } };
      reply(message.id, { thread });
      // F11: mirrors the real server - resuming a thread clears its goal, confirmed via thread/goal/cleared.
      if (thread.goal != null) {
        thread.goal = null;
        notify('thread/goal/cleared', { threadId: thread.id });
      }
      return;
    }
    if (message.method === 'turn/interrupt') {
      const timer = timers.get(params.threadId);
      if (timer) clearTimeout(timer);
      timers.delete(params.threadId);
      reply(message.id, {});
      const thread = threads.get(params.threadId);
      const strayTurn = thread?.turns.find(t => t.id === params.turnId);
      if (strayTurn) strayTurn.status = 'interrupted';
      notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [], error: null } });
      return;
    }
    // The client's answer to a server-initiated approval request (or, for
    // [unknown-request], to a request type the runtime does not normalize at all).
    if (message.id !== undefined && !message.method && (message.result !== undefined || message.error !== undefined)) {
      const pending = timers.get('approval:' + message.id);
      if (pending) {
        timers.delete('approval:' + message.id);
        notify('fixture/approvalDecision', { requestId: message.id, result: message.result });
        pending(message.result);
      }
      const unknownPending = timers.get('unknown:' + message.id);
      if (unknownPending) {
        timers.delete('unknown:' + message.id);
        notify('fixture/unknownRequestSettled', { requestId: message.id, error: message.error || null });
        unknownPending();
      }
      return;
    }
    if (message.method === 'turn/start') {
      const turnId = 'turn_' + (++serial);
      const promptText = params.input[0].text;
      reply(message.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId } });
      if (promptText.includes('[hang]')) return;
      const run = () => {
        if (promptText.includes('[stream]')) {
          notify('item/agentMessage/delta', { threadId: params.threadId, turnId, delta: 'partial ' });
          notify('item/reasoning/textDelta', { threadId: params.threadId, turnId, delta: 'thinking ' });
          notify('item/commandExecution/outputDelta', { threadId: params.threadId, turnId, delta: 'output ' });
        }
        if (promptText.includes('[command]')) {
          const item = { id: 'cmd_' + turnId, type: 'commandExecution', command: 'echo fixture', cwd: params.cwd, status: 'completed', exitCode: 0 };
          notify('item/started', { threadId: params.threadId, turnId, item: { id: item.id, type: 'commandExecution', command: item.command } });
          notify('item/completed', { threadId: params.threadId, turnId, item });
        }
        if (promptText.includes('[background-turn]')) {
          const thread = threads.get(params.threadId);
          if (thread) thread.turns.push({ id: 'stray_1', status: 'inProgress' });
        }
        complete(params.threadId, turnId, promptText);
      };
      if (promptText.includes('[approval]')) {
        const approvalId = 'approval_' + turnId;
        timers.set('approval:' + approvalId, () => run());
        send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId, itemId: 'cmd_' + turnId, command: 'echo test', reason: 'Fixture permission boundary.' } });
        return;
      }
      if (promptText.includes('[unknown-request]')) {
        const requestId = 'unknown_' + turnId;
        timers.set('unknown:' + requestId, () => run());
        send({ id: requestId, method: 'debug/customRequest', params: { threadId: params.threadId } });
        return;
      }
      const delay = promptText.includes('[delay]') ? 200 : 5;
      timers.set(params.threadId, setTimeout(run, delay));
      return;
    }
    send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method: ' + message.method } });
  } catch (error) {
    console.error(error.stack);
    process.exit(1);
  }
});
lines.on('close', () => process.exit(0));

