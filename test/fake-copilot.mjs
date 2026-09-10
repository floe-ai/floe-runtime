// Controlled ACP fixture standing in for `copilot --acp`, used only by this
// package's own tests. Understands markers embedded in the prompt text to
// drive different completion paths:
//   [bad-json]     final agent_message_chunk text is not JSON
//   [missing]      final agent_message_chunk text is valid JSON missing a required field
//   [delay]        waits before completing, so a test can interrupt() first
//   [cancel-only]  never resolves session/prompt on its own; only responds once session/cancel arrives
//   [tool-call]    emits a tool_call then a completed tool_call_update before the report
//   [permission]   sends a session/request_permission request before completing
//   [refusal]      completes with stopReason 'refusal' and a generic refusal message
//   [refusal-quota] like [refusal], but the message contains quota/spend-cap language, exercising the
//                  F9 Copilot heuristic (UNCONFIRMED against the real backend - see copilot.mjs)
// Also understands the real control-command slash-commands (/usage, /compact,
// /autopilot, /permissions, /allow-all) as plain prompt text, matching how the
// real `copilot --acp` server treats them (see src/adapters/copilot.mjs).
import readline from 'node:readline';

let serial = 0;
const sessions = new Map(); // sessionId -> { cwd, currentModelId, updatedAt }
const pendingPrompts = new Map(); // sessionId -> { id, timer }
const pendingPermissions = new Map(); // requestId -> continuation callback
const requestCounts = {}; // method -> call count, exposed via debug/counters for polling-ban assertions
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });

function reportText(promptText) {
  if (promptText.startsWith('/usage')) return 'Requests: 3 AI Units: 12';
  if (promptText.startsWith('/compact')) return 'Conversation compacted.';
  if (promptText.startsWith('/autopilot')) return 'Autopilot updated.';
  if (promptText.startsWith('/allow-all')) return 'Permissions set to allow-all.';
  if (promptText.startsWith('/permissions')) return 'Permissions set to default.';
  if (promptText.startsWith('/fleet')) return 'Fleet mode enabled.';
  if (promptText.startsWith('/every')) return 'Recurring schedule set.';
  if (promptText.startsWith('/after')) return 'One-shot schedule set.';
  if (promptText.includes('[bad-json]')) return 'not json';
  if (promptText.includes('[missing]')) return '{}';
  return JSON.stringify({ ok: true, summary: 'Fixture output' });
}

function finishPrompt(sessionId, promptText, stopReason = 'end_turn') {
  const pending = pendingPrompts.get(sessionId);
  if (!pending) return;
  pendingPrompts.delete(sessionId);
  if (pending.timer) clearTimeout(pending.timer);
  const session = sessions.get(sessionId);
  if (session) session.updatedAt = new Date().toISOString();
  if (promptText.includes('[no-usage-update]') && session) session.suppressUsageUpdate = true;
  if (stopReason === 'end_turn') {
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: reportText(promptText) } } });
    // Structured usage lands as a push notification on (almost) every turn, per PART 4 correction:
    // usage() must treat this as PRIMARY, not the /usage text reply. A session that has ever sent
    // [no-usage-update] stays suppressed for its lifetime, simulating a backend/session that never
    // reports structured usage, so tests can exercise the text-fallback path deliberately.
    if (!session?.suppressUsageUpdate) {
      // [cost=N] lets a test control exactly how much simulated spend a turn ADDS, for Fleet budget
      // tests. Real backends report cumulative session-to-date cost in usage_update, so this fixture
      // accumulates it per session too, rather than resetting to N on every turn.
      const costMatch = promptText.match(/\[cost=([\d.]+)]/);
      if (session) session.cumulativeCost = (session.cumulativeCost || 0) + (costMatch ? Number(costMatch[1]) : 0.05);
      const cost = session ? session.cumulativeCost : (costMatch ? Number(costMatch[1]) : 0.05);
      notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used: 12, size: 128000, cost } });
    }
  }
  reply(pending.id, { stopReason });
}

function startPromptWork(sessionId, promptText) {
  if (promptText.includes('[refusal')) {
    const message = promptText.includes('[refusal-quota]')
      ? 'I cannot continue: you have hit your usage limit / spend cap for this billing period.'
      : 'I will not help with that request.';
    const pending = pendingPrompts.get(sessionId);
    const timer = setTimeout(() => {
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: message } } });
      pendingPrompts.delete(sessionId);
      reply(pending.id, { stopReason: 'refusal' });
    }, 5);
    pendingPrompts.set(sessionId, { id: pending.id, timer });
    return;
  }
  if (promptText.includes('[tool-call]')) {
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Running fixture command', kind: 'execute', status: 'pending', rawInput: { command: 'echo fixture' } } });
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', content: [{ text: 'command output' }] } });
  }
  if (promptText.includes('[permission]')) {
    const requestId = 'perm_' + (++serial);
    pendingPermissions.set(requestId, () => {
      const delay = promptText.includes('[delay]') ? 200 : 5;
      const timer = setTimeout(() => finishPrompt(sessionId, promptText), delay);
      pendingPrompts.get(sessionId).timer = timer;
    });
    send({
      id: requestId, method: 'session/request_permission',
      params: {
        sessionId, toolCall: { toolCallId: 'call_1', title: 'Run a fixture command', kind: 'execute' },
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      },
    });
    return;
  }
  const delay = promptText.includes('[delay]') ? 200 : 5;
  const timer = setTimeout(() => finishPrompt(sessionId, promptText), delay);
  pendingPrompts.set(sessionId, { id: pendingPrompts.get(sessionId).id, timer });
}

const AVAILABLE_COMMANDS = [
  { name: 'usage', description: 'Display session usage metrics and statistics', input: { hint: null } },
  { name: 'compact', description: 'Summarize conversation history to reduce context window usage', input: { hint: 'focus instructions' } },
  { name: 'autopilot', description: 'Toggle autopilot mode, or set an autopilot objective', input: { hint: '[on|off|<objective>] [--max-ai-credits <N>]' } },
  { name: 'permissions', description: 'Switch between permission modes', input: { hint: '[default|allow-all|show]' } },
  { name: 'allow-all', description: 'Enable all permissions', input: { hint: '[on|off|show]' } },
];

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  try {
    const message = JSON.parse(line);
    const params = message.params || {};
    if (message.method) requestCounts[message.method] = (requestCounts[message.method] || 0) + 1;
    if (message.method === 'initialize') {
      return reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {} }, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: {} },
        agentInfo: { name: 'fake-copilot', title: 'Fake Copilot', version: '1.0.0' },
        authMethods: [],
      });
    }
    if (message.method === 'session/new') {
      const sessionId = 'sess_' + (++serial);
      sessions.set(sessionId, { cwd: params.cwd, currentModelId: 'fixture-model', updatedAt: new Date().toISOString() });
      // The real session/new result wraps models in an object, not a bare array (B1 fix).
      reply(message.id, {
        sessionId,
        models: { availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }, { modelId: 'fixture-model-2', name: 'Fixture model 2' }], currentModelId: 'fixture-model' },
      });
      notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: AVAILABLE_COMMANDS } });
      return;
    }
    if (message.method === 'session/close') { sessions.delete(params.sessionId); return reply(message.id, {}); }
    if (message.method === 'session/set_model') {
      const session = sessions.get(params.sessionId);
      if (session) session.currentModelId = params.modelId;
      return reply(message.id, {});
    }
    if (message.method === 'session/set_mode') return reply(message.id, {});
    if (message.method === 'session/fork') return reply(message.id, { sessionId: 'sess_fork_' + (++serial) });
    if (message.method === 'session/list') return reply(message.id, { data: [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, updatedAt: session.updatedAt })) });
    if (message.method === 'session/load') {
      const sessionId = params.sessionId;
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'replay_1', content: { type: 'text', text: 'replayed history' } } });
      return reply(message.id, null);
    }
    // Test-only debug hooks: not part of the real ACP surface.
    if (message.method === 'debug/crash') { process.exit(1); return; } // simulates a shard subprocess dying, for Fleet crash-recovery tests
    if (message.method === 'debug/counters') return reply(message.id, { requestCounts });
    if (message.method === 'debug/age-session') {
      const session = sessions.get(params.sessionId);
      if (session) session.updatedAt = new Date(Date.now() - params.ageMs).toISOString();
      return reply(message.id, {});
    }
    // The client's answer to a server-initiated session/request_permission.
    if (message.id !== undefined && !message.method && message.result !== undefined) {
      const continuation = pendingPermissions.get(message.id);
      if (continuation) {
        pendingPermissions.delete(message.id);
        notify('fixture/permissionDecision', { requestId: message.id, result: message.result });
        continuation();
      }
      return;
    }
    if (message.method === 'session/prompt') {
      const promptText = params.prompt[0].text;
      if (promptText.includes('[cancel-only]')) { pendingPrompts.set(params.sessionId, { id: message.id, timer: null }); return; }
      pendingPrompts.set(params.sessionId, { id: message.id, timer: null });
      startPromptWork(params.sessionId, promptText);
      return;
    }
    if (message.method === 'session/cancel') { finishPrompt(params.sessionId, '', 'cancelled'); return; }
    send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method: ' + message.method } });
  } catch (error) {
    console.error(error.stack);
    process.exit(1);
  }
});
lines.on('close', () => process.exit(0));
