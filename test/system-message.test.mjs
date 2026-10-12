import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import {
  BASE_SYSTEM_MESSAGE_DIR,
  appendedSystemMessage,
  copilotSystemMessage,
  floeBaseSystemMessage,
  loadBaseSections,
  mergeSystemMessageLayers,
  parseSectionFile,
  withoutTaggedBlocks,
} from '../src/system-message.mjs';
import { CodexRuntime } from '../src/adapters/codex.mjs';

const copilot = (...values) => copilotSystemMessage(mergeSystemMessageLayers(
  floeBaseSystemMessage(),
  values.map((value, index) => ({ label: index === 0 ? 'Application' : 'Actor', value })),
));

const RUNTIME_VENDOR_TEXT = `<system_notifications>
Notifications.
</system_notifications>

<user_progress_updates>
Progress habits.
</user_progress_updates>

<session_context>
Session folder: C:/secret/path
</session_context>

<git_commit_trailer>
Co-authored-by: Copilot
</git_commit_trailer>`;

test('the Floe base removes vendor identity and coding-assistant sections', () => {
  const { sections } = copilot();
  for (const id of ['identity', 'preamble', 'tone', 'tool_efficiency', 'environment_context', 'code_change_rules', 'guidelines', 'custom_instructions', 'last_instructions']) {
    assert.deepEqual(sections[id], { action: 'remove' }, id);
  }
  assert.equal(sections.safety.action, 'replace');
  assert.doesNotMatch(sections.safety.content, /GitHub|CLI|our security/);
});

test('the Floe base keeps runtime and tool guidance without CLI-product blocks', () => {
  const { sections } = copilot();
  const runtime = sections.runtime_instructions.action(RUNTIME_VENDOR_TEXT);
  assert.match(runtime, /<system_notifications>/);
  assert.doesNotMatch(runtime, /session_context|secret|git_commit_trailer|user_progress_updates/);
  const tools = sections.tool_instructions.action('<view>\nView.\n</view>\n<gh_cli_preference>\nUse gh.\n</gh_cli_preference>\n<code_search_tools>\nLSP.\n</code_search_tools>');
  assert.equal(tools, '<view>\nView.\n</view>');
});

test('application and actor layers stack instead of the actor replacing the application', () => {
  const { sections } = copilot(
    { content: 'App rules.', sections: { preamble: { action: 'replace', content: 'You are a Floe actor.' } } },
    { content: 'Actor rules.', sections: { preamble: { action: 'append', content: 'Your name is Ada.' } } },
  );
  assert.deepEqual(sections.preamble, { action: 'replace', content: 'You are a Floe actor.\n\nYour name is Ada.' });
  assert.deepEqual(sections.last_instructions, { action: 'replace', content: 'App rules.\n\nActor rules.' });
});

test('a later layer can override any section, including Floe base text and earlier layers', () => {
  const { sections } = copilot(
    { sections: { tone: { action: 'replace', content: 'App tone.' }, safety: { action: 'append', content: 'App safety.' } } },
    { sections: { tone: { action: 'remove' }, safety: { action: 'replace', content: 'Actor safety.' }, guidelines: { action: 'preserve' } } },
  );
  assert.deepEqual(sections.tone, { action: 'remove' });
  assert.deepEqual(sections.safety, { action: 'replace', content: 'Actor safety.' });
  assert.deepEqual(sections.guidelines, { action: 'preserve' });
});

test('append and prepend onto vendor text wrap the filtered vendor content', () => {
  const { sections } = copilot({ sections: {
    runtime_instructions: { action: 'append', content: 'Use floe_send to reply to other actors.' },
    tool_instructions: { action: 'prepend', content: 'Floe tools come first.' },
  } });
  const runtime = sections.runtime_instructions.action(RUNTIME_VENDOR_TEXT);
  assert.match(runtime, /<\/system_notifications>\n\nUse floe_send to reply to other actors\.$/);
  assert.doesNotMatch(runtime, /secret/);
  assert.equal(sections.tool_instructions.action('<view>V</view>'), 'Floe tools come first.\n\n<view>V</view>');
});

test('a string layer and append mode both add content', () => {
  const { sections } = copilot('App text.', { mode: 'append', content: 'Actor text.' });
  assert.deepEqual(sections.last_instructions, { action: 'replace', content: 'App text.\n\nActor text.' });
});

test('replace mode removes every section and earlier content', () => {
  const { sections } = copilot('App text.', { mode: 'replace', content: 'Only this.' });
  assert.deepEqual(sections.safety, { action: 'remove' });
  assert.deepEqual(sections.tool_instructions, { action: 'remove' });
  assert.deepEqual(sections.runtime_instructions, { action: 'remove' });
  assert.deepEqual(sections.last_instructions, { action: 'replace', content: 'Only this.' });
});

test('malformed layers are rejected with the layer named', () => {
  assert.throws(() => copilot({ sections: { tone: { action: 'rewrite' } } }), /Application systemMessage section 'tone'/);
  assert.throws(() => copilot(undefined, { sections: { tone: { action: 'replace' } } }), /Actor systemMessage section 'tone' action 'replace' needs string content/);
  assert.throws(() => copilot({ mode: 'other' }), /mode must be/);
  assert.throws(() => copilot(42), /must be a string or an object/);
});

test('append-only rendering keeps layer text in section order and ignores removals', () => {
  const merged = mergeSystemMessageLayers(null, [
    { label: 'Application', value: { content: 'App rules.', sections: { safety: { action: 'append', content: 'Stay in role.' }, tone: { action: 'replace', content: 'Be plain.' } } } },
    { label: 'Actor', value: { sections: { preamble: { action: 'replace', content: 'You are Ada.' }, guidelines: { action: 'remove' } } } },
  ]);
  assert.equal(appendedSystemMessage(merged), 'You are Ada.\n\nBe plain.\n\nStay in role.\n\nApp rules.');
  assert.equal(appendedSystemMessage(mergeSystemMessageLayers(null, [])), '');
});

test('withoutTaggedBlocks leaves unknown tags and plain text alone', () => {
  assert.equal(withoutTaggedBlocks('keep\n<a>x</a>\n\n\n<b>y</b>', ['a']), 'keep\n\n<b>y</b>');
});

test('every base section file is a known section with a reason', () => {
  const files = readdirSync(BASE_SYSTEM_MESSAGE_DIR).filter(name => name.endsWith('.md') && name !== 'README.md');
  assert.ok(files.length > 0);
  for (const file of files) {
    const { fields } = parseSectionFile(readFileSync(path.join(BASE_SYSTEM_MESSAGE_DIR, file), 'utf8'), file);
    assert.ok(fields.reason, `${file} needs a reason`);
  }
  assert.deepEqual(Object.keys(loadBaseSections()).sort(), files.map(file => file.slice(0, -3)).sort());
});

test('section file parsing reads fields, lists and body, and rejects missing front matter', () => {
  const parsed = parseSectionFile('\uFEFF---\r\naction: vendor\r\nreason: Why.\r\nstrip:\r\n  - a\r\n  - b\r\n---\r\n\r\nBody text.\r\n', 'x.md');
  assert.deepEqual(parsed, { fields: { action: 'vendor', reason: 'Why.', strip: ['a', 'b'] }, body: 'Body text.' });
  assert.throws(() => parseSectionFile('no front matter', 'x.md'), /x\.md must start with/);
  assert.throws(() => parseSectionFile('---\nnot a field\n---\n', 'x.md'), /unreadable front-matter line/);
});

test('Codex receives layered text as developer instructions on a new thread', async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs');
  const runtime = new CodexRuntime({
    executable: process.execPath, args: [fixture], timeoutMs: 5000,
    systemMessage: { sections: { preamble: { action: 'replace', content: 'You are a Floe actor.' } } },
  });
  try {
    const { threadId } = await runtime.run('worker', { prompt: 'hi' }, '/tmp/work', () => {}, { systemMessage: 'Your name is Ada.' });
    const { thread } = await runtime.request('thread/read', { threadId });
    assert.equal(thread.developerInstructions, 'You are a Floe actor.\n\nYour name is Ada.');
    assert.equal(runtime.capabilities().systemMessageSections, false);
  } finally {
    await runtime.close();
  }
});

test('Codex sends no developer instructions when no layer adds text', async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs');
  const runtime = new CodexRuntime({ executable: process.execPath, args: [fixture], timeoutMs: 5000 });
  try {
    const { threadId } = await runtime.run('worker', { prompt: 'hi' }, '/tmp/work');
    const { thread } = await runtime.request('thread/read', { threadId });
    assert.equal(thread.developerInstructions, null);
  } finally {
    await runtime.close();
  }
});
