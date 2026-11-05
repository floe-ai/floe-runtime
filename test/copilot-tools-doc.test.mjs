import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COPILOT_BUILTIN_TOOL_MANIFEST } from '../src/adapters/copilot-tools.mjs';

const doc = readFileSync(new URL('../docs/copilot-tools.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function toolRows(heading) {
  const start = doc.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `docs/copilot-tools.md needs a '## ${heading}' section`);
  const end = doc.indexOf('\n## ', start + 3);
  const section = doc.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^\| `([^`]+)` \| ([^|]+) \|/gm)].map(([, name, second]) => ({ name, second: second.trim() }));
}

test('the tool doc lists exactly the governed Windows tools with their catalogs', () => {
  const manifest = COPILOT_BUILTIN_TOOL_MANIFEST.win32;
  const rows = toolRows('Allowed tools');
  assert.deepEqual(rows.map(row => row.name).sort(), Object.keys(manifest).sort());
  for (const { name, second } of rows) {
    const expected = manifest[name].catalogs.length === 2 ? 'both' : manifest[name].catalogs[0];
    assert.equal(second, expected, `${name} catalog`);
  }
});

test('no tool the doc calls blocked is in any governed manifest', () => {
  const blocked = toolRows('Blocked Copilot tools').map(row => row.name);
  assert.ok(blocked.includes('task'));
  for (const manifest of Object.values(COPILOT_BUILTIN_TOOL_MANIFEST)) {
    for (const name of blocked) assert.equal(Object.hasOwn(manifest, name), false, name);
  }
});
