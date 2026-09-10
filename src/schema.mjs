// Structured-output extraction and validation, shared by every adapter.
//
// Schema *ownership* stays with the consuming app (it defines its own
// per-role JSON Schemas and prompts) - this module only provides the
// mechanics: a small JSON-Schema-subset validator, and helpers to pull a
// JSON object out of an agent's final free-text message and validate it.
//
// Backends differ in how strictly they can be made to emit exactly this
// JSON: Codex supports a server-enforced `outputSchema` on turn/start, while
// ACP (Copilot) has no equivalent, so its adapter must rely on
// promptInstructionFor() plus this same validation/extraction path.
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
 * Parses `text` as JSON (stripping a surrounding ```json fence if present,
 * since prompt-instructed backends sometimes wrap their output) and
 * validates it against `schema`. Throws RuntimeFault('invalid_report', ...)
 * on any parse or validation failure.
 */
export function extractStructuredOutput(text, schema, { role = 'agent' } = {}) {
  const unfenced = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed;
  try { parsed = JSON.parse(unfenced); }
  catch (error) { throw new RuntimeFault('invalid_report', `The ${role} did not return valid JSON: ${error.message}`, 502); }
  try { return validate(parsed, schema); }
  catch (error) { throw new RuntimeFault('invalid_report', `The ${role} returned an invalid report: ${error.message}`, 502); }
}

/**
 * Renders an instruction block asking the model to reply with JSON matching
 * `schema`. Backends without server-enforced structured output (e.g.
 * Copilot/ACP) should append this to their prompt; backends with native
 * enforcement (e.g. Codex's outputSchema) don't need it.
 */
export function promptInstructionFor(schema) {
  return `Respond with a single JSON object only (no prose, no markdown fences) matching this JSON Schema:\n${JSON.stringify(schema)}`;
}
