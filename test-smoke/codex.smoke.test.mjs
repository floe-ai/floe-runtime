// Real-binary smoke tests for the Codex adapter. Costs real credits and real time - see
// test-smoke/README.md. Never run automatically as part of `npm test`; run with `npm run smoke`.
//
// The workspace this suite runs against has its spend cap exhausted (per the user, until the October 1st
// reset). Every test here therefore expects to hit F9's usage_limit_exceeded fault and SKIP cleanly with
// an explicit "Codex unavailable: spend cap reached" message - this is a live confirmation of the F9
// fault-detection work in src/adapters/codex.mjs, not a bug in this suite. The moment the cap resets,
// these tests will simply start passing without any code changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCodexRuntime, killUngracefully, waitForLost } from './helpers.mjs';

async function probeCodex() {
  const runtime = makeCodexRuntime();
  try {
    await runtime.start();
    return { ok: true, runtime };
  } catch (error) {
    return { ok: false, reason: `Codex unavailable: ${error.message}`, runtime };
  }
}

const availability = await probeCodex();
if (availability.runtime) await availability.runtime.close().catch(() => {});
const skip = availability.ok ? false : availability.reason;

test('Codex smoke: a thread survives a real subprocess SIGKILL and resumes with full context', { skip }, async (t) => {
  const first = makeCodexRuntime();
  let threadId;
  const cwd = process.cwd();
  try {
    const codeword = 'floe-smoke-' + Math.random().toString(36).slice(2, 8);
    let planted;
    try {
      planted = await first.run(
        'worker',
        { prompt: `Remember this codeword for later: ${codeword}. Reply with the single word: ok.` },
        cwd,
        () => {},
        { timeoutMs: 60000 },
      );
    } catch (error) {
      // F9 in action: the spend cap makes every real Codex turn fail this way right now. Skip cleanly
      // rather than reporting a failure - this IS the expected, documented state of the account.
      if (error.code === 'usage_limit_exceeded') { t.skip('Codex unavailable: spend cap reached'); return; }
      throw error;
    }
    threadId = planted.threadId;
    await first.quiesce(threadId);

    const lost = waitForLost(first);
    killUngracefully(first);
    await lost;

    const second = makeCodexRuntime();
    try {
      const events = [];
      second.on('event', envelope => events.push(envelope));
      await second.resume(threadId);
      const replayed = events.filter(e => e.replay === true);
      assert.ok(replayed.length > 0, 'resume() must mark the restored snapshot as replay:true');
      assert.ok(events.some(e => e.type === 'replayComplete'));

      let recall;
      try {
        recall = await second.run(
          'worker',
          { prompt: 'What was the codeword I asked you to remember? Reply with only the codeword, nothing else.' },
          cwd,
          () => {},
          { timeoutMs: 60000 },
          { threadId, scope: threadId },
        );
      } catch (error) {
        if (error.code === 'usage_limit_exceeded') { t.skip('Codex unavailable: spend cap reached'); return; }
        throw error;
      }
      assert.ok(recall.text.includes(codeword) || recall.report?.summary?.includes(codeword), `expected the resumed thread to recall "${codeword}"`);
      await second.quiesce(threadId);
      await second.retire(threadId);
    } finally {
      await second.close();
    }
  } finally {
    await first.close().catch(() => {});
  }
});
