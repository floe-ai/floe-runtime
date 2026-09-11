import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuredOutput, validate, promptInstructionFor } from '../src/schema.mjs';

const schema = { type: 'object', properties: { status: { type: 'string', enum: ['ok', 'error'] } }, required: ['status'], additionalProperties: false };

// LIVE EVIDENCE: this is the exact text (verbatim) a real `copilot --acp` reply returned for a
// Star-Map-shaped prompt (do a small task, then report against a schema). This case alone proves the
// regression AND the fix: the model's JSON was always valid, it was just not the whole reply.
const REAL_COPILOT_REPLY = `Info: C:\\Development\\_temp\\acp-stream-test\\hello.txtNo version control exists in this folder - want me to run \`git init\` and publish it to your falllingreign GitHub account?

\`\`\`json
{
  "summary": "Created hello.txt in C:\\\\Development\\\\_temp\\\\acp-stream-test containing the word 'hello'.",
  "filesTouched": ["C:\\\\Development\\\\_temp\\\\acp-stream-test\\\\hello.txt"],
  "complete": true
}
\`\`\``;
const reportSchema = { type: 'object', properties: { summary: { type: 'string' }, filesTouched: { type: 'array', items: { type: 'string' } }, complete: { type: 'boolean' } }, required: ['summary', 'filesTouched', 'complete'], additionalProperties: false };

const cases = [
  {
    name: 'reproduces + recovers the real regression: prose, then a fenced ```json block (verbatim real-binary text)',
    text: REAL_COPILOT_REPLY, schema: reportSchema,
    expect: { summary: "Created hello.txt in C:\\Development\\_temp\\acp-stream-test containing the word 'hello'.", filesTouched: ['C:\\Development\\_temp\\acp-stream-test\\hello.txt'], complete: true },
  },
  {
    name: 'prose, then a bare unfenced object',
    text: 'Sure, here is the result:\n{"status":"ok"}', schema,
    expect: { status: 'ok' },
  },
  {
    name: 'a bare object only (the cheap, common case)',
    text: '{"status":"ok"}', schema,
    expect: { status: 'ok' },
  },
  {
    name: 'a fenced block with no language tag',
    text: 'Done.\n```\n{"status":"ok"}\n```', schema,
    expect: { status: 'ok' },
  },
  {
    name: 'trailing prose AFTER the JSON',
    text: '{"status":"ok"}\nLet me know if you need anything else.', schema,
    expect: { status: 'ok' },
  },
  {
    name: 'an object whose string values contain braces and backticks',
    text: 'Here: {"status":"ok","note":"use `{unused}` in your config"}'.replace('"note":"use `{unused}` in your config"', '"note":"use `{unused}` in your config"'),
    schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok', 'error'] }, note: { type: 'string' } }, required: ['status'], additionalProperties: false },
    expect: { status: 'ok', note: 'use `{unused}` in your config' },
  },
  {
    name: 'two objects present where only the second matches the schema',
    text: 'First, unrelated: {"other":"thing"}\nThen the real report: {"status":"ok"}', schema,
    expect: { status: 'ok' },
  },
];

for (const c of cases) {
  test(`extractStructuredOutput(): ${c.name}`, () => {
    assert.deepEqual(extractStructuredOutput(c.text, c.schema), c.expect);
  });
}

test('extractStructuredOutput(): genuinely no JSON at all -> clear error containing a snippet of what was received', () => {
  const text = "I'm not sure what you mean - could you clarify the task?";
  assert.throws(
    () => extractStructuredOutput(text, schema),
    error => error.code === 'invalid_report' && error.message.includes(text),
  );
});

test('extractStructuredOutput(): a JSON object that parses but fails schema validation still fails clearly', () => {
  const text = '{"status":"not-a-real-status"}';
  assert.throws(
    () => extractStructuredOutput(text, schema),
    error => error.code === 'invalid_report' && error.message.length > 0,
  );
});

test('extractStructuredOutput(): does not use a greedy match that would span two unrelated objects', () => {
  // A naive /\{[\s\S]*\}/ regex would span from the first '{' to the LAST '}' across both objects,
  // producing one invalid blob. The real scan must find each object as its own balanced span.
  const text = '{"other":"thing"} some prose in between {"status":"ok"}';
  assert.deepEqual(extractStructuredOutput(text, schema), { status: 'ok' });
});

test('validate() rejects additionalProperties when the schema forbids them', () => {
  assert.throws(() => validate({ status: 'ok', extra: 1 }, schema), error => error.code === 'report_schema');
});

test('promptInstructionFor() renders a non-empty instruction mentioning the schema', () => {
  const instruction = promptInstructionFor(schema);
  assert.ok(instruction.length > 0);
  assert.ok(instruction.includes('"status"'));
});
