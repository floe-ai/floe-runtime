// Structured-output extraction and validation, shared by every adapter.
//
// Schema *ownership* stays with the consuming app (it defines its own
// per-role JSON Schemas and prompts) - this module only provides the
// mechanics: a small JSON-Schema-subset validator, and helpers to pull a
// JSON object out of an agent's final free-text message and validate it.
//
// Backends differ in how strictly they can be made to emit exactly this
// JSON: Codex supports a server-enforced `outputSchema` on turn/start, while
// Copilot's SDK adapter relies on
// promptInstructionFor() plus this same validation/extraction path.
//
// LIVE EVIDENCE (against the real Copilot runtime, a Star-Map-shaped
// prompt: do a small task, then report against a schema) - the model reliably
// produces VALID, schema-correct JSON. It just doesn't put ONLY that JSON in
// its reply: a real response looked like
//   I created hello.txt in ...\n\n```json\n{"summary": "...", ...}\n```
// - conversational prose in front, and the object wrapped in a fenced code
// block. The old implementation here trimmed a fence only at the very start/
// end of the WHOLE string, then ran a single JSON.parse over the entire
// reply - so it broke on the very first character of that leading prose
// ("Unexpected token 'I' ... is not valid JSON"). That was never a model
// capability gap: it was this module only looking in the wrong place. The
// fix is to find the JSON wherever it actually is, not to add a second model
// call or any interpreter/tool-call machinery.
import { RuntimeFault } from './errors.mjs';

/**
 * Validates `value` against a small JSON-Schema subset (object/array/string/
 * boolean/number/null, enum, anyOf, required, additionalProperties=false).
 * Throws a RuntimeFault('report_schema', ...) on the first violation.
 */
export function validate(value, schema, location = 'report') {
  if (schema.anyOf) {
    for (const candidate of schema.anyOf) {
      try { validate(value, candidate, location); return value; } catch { /* try next candidate */ }
    }
    throw new RuntimeFault('report_schema', `${location} does not match the required contract.`, 502);
  }
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  check(types.includes(actual), location, `must be ${types.join(' or ')}.`);
  if (schema.enum) check(schema.enum.includes(value), location, 'has an unsupported value.');
  if (actual === 'string' && Number.isFinite(schema.maxLength)) check(value.length <= schema.maxLength, location, 'is too long.');
  if (actual === 'array') {
    if (Number.isFinite(schema.maxItems)) check(value.length <= schema.maxItems, location, 'has too many items.');
    value.forEach((item, i) => validate(item, schema.items, `${location}[${i}]`));
  }
  if (actual === 'object') {
    for (const key of schema.required || []) check(Object.hasOwn(value, key), location, `.${key} is required.`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) check(schema.properties?.[key], `${location}.${key}`, 'is not allowed.');
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(item, schema.properties[key], `${location}.${key}`);
    }
  }
  return value;
}

function check(condition, location, suffix) {
  if (!condition) throw new RuntimeFault('report_schema', `${location} ${suffix}`, 502);
}

/**
 * Scans `text` for every ```json ... ``` (or unlabelled ``` ... ```) fenced
 * block, returning their inner contents in order. Checked BEFORE a raw brace
 * scan because a fence is an explicit, unambiguous signal of "this is the
 * object" - the model chose to delimit it, so there's no need to guess.
 */
function fencedCandidates(text) {
  const candidates = [];
  const re = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) candidates.push(m[1].trim());
  return candidates;
}

/**
 * Scans `text` for every balanced top-level `{...}` object (respecting
 * quoted-string content, including escaped characters and braces inside
 * strings/backticks, so those don't confuse the brace count), returning each
 * span found. A real brace-matching scan is used deliberately instead of a
 * greedy /\{[\s\S]*\}/ regex, which would span from the FIRST `{` to the
 * LAST `}` in the text and swallow two unrelated objects (or trailing prose
 * containing a stray brace) into one invalid blob.
 */
function balancedCandidates(text) {
  const candidates = [];
  let fromIndex = 0;
  for (;;) {
    const start = text.indexOf('{', fromIndex);
    if (start === -1) break;
    let depth = 0, inString = false, escape = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) break; // unbalanced from here on - nothing more to find
    candidates.push(text.slice(start, end));
    fromIndex = end;
  }
  return candidates;
}

/** A short, single-line snippet of `text` for error messages, so the next person debugging a failed
 * extraction can see what was actually received without digging through logs. */
function snippet(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Parses `text` as JSON and validates it against `schema` - tolerant of the
 * agent surrounding the actual report with prose, wrapping it in a fenced
 * code block, or trailing it with further commentary. Tries, in order:
 *   1. The whole trimmed text as-is (the cheap, common case: a reply that is
 *      nothing but the object).
 *   2. Every fenced ```json``` (or bare ```) block found anywhere in the
 *      text, in order.
 *   3. Every balanced top-level `{...}` object found anywhere in the text,
 *      in order.
 * For (2) and (3), each candidate is tried in turn; the first one that BOTH
 * parses as JSON AND validates against `schema` wins - this is what lets a
 * false-start match (an unrelated object, or one that doesn't match this
 * schema) get skipped in favour of the real report later in the same reply.
 * Throws RuntimeFault('invalid_report', ...) if nothing recovers, with a
 * snippet of the actual text in the message.
 */
export function extractStructuredOutput(text, schema, { role = 'agent' } = {}) {
  const raw = String(text ?? '').trim();
  const tryParse = candidate => {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { return undefined; }
    try { return validate(parsed, schema); } catch { return undefined; }
  };
  const direct = tryParse(raw);
  if (direct !== undefined) return direct;
  for (const candidate of fencedCandidates(raw)) {
    const result = tryParse(candidate);
    if (result !== undefined) return result;
  }
  for (const candidate of balancedCandidates(raw)) {
    const result = tryParse(candidate);
    if (result !== undefined) return result;
  }
  const hasAnyJson = fencedCandidates(raw).length > 0 || balancedCandidates(raw).length > 0;
  const detail = hasAnyJson
    ? `no JSON object in the reply matched the required schema (received: "${snippet(raw)}")`
    : `no JSON object was found in the reply (received: "${snippet(raw)}")`;
  throw new RuntimeFault('invalid_report', `The ${role} did not return a valid report: ${detail}`, 502);
}

/**
 * Renders an instruction block asking the model to reply with JSON matching
 * `schema`. Backends without server-enforced structured output (e.g.
 * Copilot) should append this to their prompt; backends with native
 * enforcement (e.g. Codex's outputSchema) don't need it.
 */
export function promptInstructionFor(schema) {
  return `Respond with a single JSON object only (no prose, no markdown fences) matching this JSON Schema:\n${JSON.stringify(schema)}`;
}
