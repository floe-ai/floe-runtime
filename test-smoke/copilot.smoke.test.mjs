// Real-binary smoke tests for the Copilot ACP adapter. Costs real credits and real time - see
// test-smoke/README.md. Never run automatically as part of `npm test`; run with `npm run smoke`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHEAP_COPILOT_MODEL, makeCopilotRuntime, probe, killUngracefully, waitForLost } from './helpers.mjs';

const availability = await probe(makeCopilotRuntime, 'Copilot');
const skip = availability.ok ? false : availability.reason;

test('Copilot smoke: spawns the real binary and completes the ACP handshake (B3 regression guard)', { skip }, async () => {
  const runtime = makeCopilotRuntime();
  try {
    const info = await runtime.start();
    assert.ok(info, 'initialize() must return agent info');
    assert.equal(runtime.ready, true);
  } finally {
    await runtime.close();
  }
});

test('Copilot smoke: session/new returns a live model catalogue and session/set_model changes the model (B1 guard)', { skip }, async () => {
  const runtime = makeCopilotRuntime();
  try {
    const events = [];
    runtime.on('event', envelope => events.push(envelope));
    const result = await runtime.run(
      'worker',
      { prompt: 'Reply with the single word: ok.' },
      process.cwd(),
      () => {},
      { model: CHEAP_COPILOT_MODEL, timeoutMs: 60000 },
    );
    assert.ok(result.sessionId);
    const session = runtime.sessions.get(result.sessionId);
    assert.equal(session.currentModelId, CHEAP_COPILOT_MODEL, 'session/set_model must actually change the active model');
    await runtime.quiesce(result.sessionId);
    await runtime.retire(result.sessionId);
  } finally {
    await runtime.close();
  }
});

test('Copilot smoke: session/close succeeds (B2 guard)', { skip }, async () => {
  const runtime = makeCopilotRuntime();
  try {
    const result = await runtime.run(
      'worker',
      { prompt: 'Reply with the single word: ok.' },
      process.cwd(),
      () => {},
      { model: CHEAP_COPILOT_MODEL, timeoutMs: 60000 },
    );
    await runtime.quiesce(result.sessionId);
    await runtime.retire(result.sessionId); // retire() calls session/close - must not throw
  } finally {
    await runtime.close();
  }
});

test('Copilot smoke: a session survives a real subprocess SIGKILL and resumes with full context (the most important guard)', { skip }, async () => {
  const first = makeCopilotRuntime();
  let sessionId;
  let cwd;
  try {
    cwd = process.cwd();
    const codeword = 'floe-smoke-' + Math.random().toString(36).slice(2, 8);
    const planted = await first.run(
      'worker',
      { prompt: `Remember this codeword for later: ${codeword}. Reply with the single word: ok.` },
      cwd,
      () => {},
      { model: CHEAP_COPILOT_MODEL, timeoutMs: 60000 },
    );
    sessionId = planted.sessionId;
    await first.quiesce(sessionId);

    const lost = waitForLost(first);
    killUngracefully(first); // a genuine SIGKILL, not a graceful close() - simulates a real crash
    await lost;

    const second = makeCopilotRuntime();
    try {
      const events = [];
      second.on('event', envelope => events.push(envelope));
      await second.resume(sessionId, cwd, []);
      // session/load replays the ENTIRE prior conversation as ordinary session/update notifications -
      // every one of those must be flagged `replay: true`, and a replayComplete event must mark the
      // transition back to live, so a resuming consumer never mistakes old history for current activity.
      const replayed = events.filter(e => e.replay === true);
      assert.ok(replayed.length > 0, 'resume() must mark replayed history as replay:true');
      assert.ok(events.some(e => e.type === 'replayComplete'), 'resume() must signal the transition back to live');

      const recall = await second.run(
        'worker',
        { prompt: 'What was the codeword I asked you to remember? Reply with only the codeword, nothing else.' },
        cwd,
        () => {},
        { model: CHEAP_COPILOT_MODEL, timeoutMs: 60000 },
        { sessionId },
      );
      assert.ok(recall.text.includes(codeword), `expected the resumed session to recall "${codeword}", got: ${recall.text}`);
      await second.quiesce(sessionId);
      await second.retire(sessionId);
    } finally {
      await second.close();
    }
  } finally {
    await first.close().catch(() => {}); // already dead; tolerate a no-op/failed graceful close
  }
});
