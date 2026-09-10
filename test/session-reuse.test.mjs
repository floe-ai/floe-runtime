import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey, SessionRegistry } from '../src/session-reuse.mjs';

test('sessionKey is stable for identical inputs and changes when any input changes', () => {
  const base = { role: 'worker', cwd: '/tmp/a', model: 'm', settings: { effort: 'high' }, permissions: { sandbox: 'read-only' }, scope: 'issue-1' };
  assert.equal(sessionKey(base), sessionKey({ ...base }));
  assert.notEqual(sessionKey(base), sessionKey({ ...base, cwd: '/tmp/b' }));
  assert.notEqual(sessionKey(base), sessionKey({ ...base, scope: 'issue-2' }));
});

test('SessionRegistry tracks stop state and reuse eligibility', () => {
  const registry = new SessionRegistry();
  registry.set('s1', { key: 'k1', result: { ok: true } });
  assert.equal(registry.has('s1'), true);
  assert.equal(registry.isReusable('s1', 'k1'), false, 'not reusable until stopped');
  registry.markStopped('s1');
  assert.equal(registry.isReusable('s1', 'k1'), true);
  assert.equal(registry.isReusable('s1', 'k2'), false, 'key mismatch blocks reuse');
  registry.delete('s1');
  assert.equal(registry.has('s1'), false);
});
