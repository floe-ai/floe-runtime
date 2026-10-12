/**
 * @invariant Floe owns the system message. Every backend receives the same
 * layered shape: runtime base, then application, then actor. Each later layer
 * may remove, replace, append to, prepend to, or restore any section,
 * including sections an earlier layer changed. Backends that cannot address
 * sections receive only the text that layers added, appended after the
 * backend's own instructions. The base's text lives in Markdown files under
 * src/prompts/system-message/, never in code.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Section ids in prompt order. `identity` groups preamble, tone and
// tool_efficiency; `tool_instructions` groups per-tool guidance.
export const SYSTEM_MESSAGE_SECTIONS = Object.freeze([
  'preamble', 'tone', 'tool_efficiency', 'identity', 'code_change_rules', 'guidelines', 'safety',
  'environment_context', 'tool_instructions', 'custom_instructions', 'runtime_instructions', 'last_instructions',
]);

export const SYSTEM_MESSAGE_ACTIONS = Object.freeze(['remove', 'replace', 'append', 'prepend', 'preserve']);

const removed = () => ({ source: 'removed', before: [], after: [] });
const vendor = filter => ({ source: 'vendor', ...(filter ? { filter } : {}), before: [], after: [] });

const CONTENT_ACTIONS = new Set(['replace', 'append', 'prepend']);
const BASE_ACTIONS = new Set(['remove', 'replace', 'vendor']);

export const BASE_SYSTEM_MESSAGE_DIR = fileURLToPath(new URL('./prompts/system-message/', import.meta.url));
const BLOCKS_DIR = join(BASE_SYSTEM_MESSAGE_DIR, 'blocks');

/** Parses a section file: a `---` front-matter block of `key: value` lines and `key:` lists of `- item`, then the body. */
export function parseSectionFile(source, file) {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new TypeError(`${file} must start with a --- front-matter block.`);
  const fields = {};
  let list = null;
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && list) { list.push(item[1].trim()); continue; }
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) throw new TypeError(`${file} has an unreadable front-matter line: ${line}`);
    list = null;
    if (pair[2] === '') { list = []; fields[pair[1]] = list; } else fields[pair[1]] = pair[2].trim();
  }
  return { fields, body: match[2].trim() };
}

function readBlock(tag, file) {
  let body;
  try {
    body = readFileSync(join(BLOCKS_DIR, `${tag}.md`), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  } catch {
    throw new TypeError(`${file} rewrites '${tag}' but blocks/${tag}.md is missing.`);
  }
  if (!body) throw new TypeError(`blocks/${tag}.md is empty.`);
  return body;
}

function baseSectionFromFile(file) {
  const { fields, body } = parseSectionFile(readFileSync(join(BASE_SYSTEM_MESSAGE_DIR, file), 'utf8'), file);
  const { action, strip = [], rewrite = [] } = fields;
  if (!BASE_ACTIONS.has(action)) throw new TypeError(`${file} action must be remove, replace or vendor.`);
  if (action !== 'vendor' && (strip.length || rewrite.length)) {
    throw new TypeError(`${file} may only list strip or rewrite blocks with action: vendor.`);
  }
  if (rewrite.some(tag => strip.includes(tag))) throw new TypeError(`${file} cannot both strip and rewrite the same block.`);
  if (action === 'remove' && body) throw new TypeError(`${file} has action: remove, so its body must be empty.`);
  if (action === 'replace' && !body) throw new TypeError(`${file} has action: replace but no body.`);
  if (action === 'remove') return removed();
  if (action === 'replace') return { source: 'text', text: body, before: [], after: [] };
  const replacements = Object.fromEntries(rewrite.map(tag => [tag, readBlock(tag, file)]));
  if (!strip.length && !rewrite.length) return vendor();
  return vendor(current => withRewrittenBlocks(withoutTaggedBlocks(current, strip), replacements));
}

/** Loads the runtime base from one Markdown file per section; README.md documents the format. */
export function loadBaseSections() {
  const sections = {};
  for (const file of readdirSync(BASE_SYSTEM_MESSAGE_DIR).filter(name => name.endsWith('.md') && name !== 'README.md')) {
    const id = file.slice(0, -3);
    if (!SYSTEM_MESSAGE_SECTIONS.includes(id)) throw new TypeError(`${file} does not name a system-message section.`);
    sections[id] = baseSectionFromFile(file);
  }
  return sections;
}

const BASE_SECTIONS = loadBaseSections();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes `<tag>...</tag>` blocks by name, leaving the rest of the vendor text untouched. */
export function withoutTaggedBlocks(text, tags) {
  let result = text;
  for (const tag of tags) {
    const name = escapeRegExp(tag);
    result = result.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'g'), '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Replaces the body of each present `<tag>...</tag>` block with Floe text.
 * Absent blocks stay absent, so the vendor still decides which models get them.
 */
export function withRewrittenBlocks(text, replacements) {
  let result = text;
  for (const [tag, body] of Object.entries(replacements)) {
    const name = escapeRegExp(tag);
    result = result.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'g'), () => `<${tag}>\n${body}\n</${tag}>`);
  }
  return result;
}

/** The Floe runtime base, as written in src/prompts/system-message/. */
export function floeBaseSystemMessage() {
  return {
    sections: Object.fromEntries(Object.entries(BASE_SECTIONS).map(([id, state]) => [id, { ...state }])),
    content: [],
  };
}

function normalizeLayer(layer, label) {
  if (layer == null || layer === '') return null;
  if (typeof layer === 'string') return { content: layer, sections: {} };
  if (typeof layer !== 'object' || Array.isArray(layer)) throw new TypeError(`${label} systemMessage must be a string or an object.`);
  const { mode, content, sections = {} } = layer;
  if (mode !== undefined && !['append', 'customize', 'replace'].includes(mode)) {
    throw new TypeError(`${label} systemMessage mode must be append, customize or replace.`);
  }
  if (content !== undefined && typeof content !== 'string') throw new TypeError(`${label} systemMessage content must be a string.`);
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) throw new TypeError(`${label} systemMessage sections must be an object.`);
  for (const [id, override] of Object.entries(sections)) {
    if (!override || typeof override !== 'object' || !SYSTEM_MESSAGE_ACTIONS.includes(override.action)) {
      throw new TypeError(`${label} systemMessage section '${id}' needs an action of ${SYSTEM_MESSAGE_ACTIONS.join(', ')}.`);
    }
    if (CONTENT_ACTIONS.has(override.action) && typeof override.content !== 'string') {
      throw new TypeError(`${label} systemMessage section '${id}' action '${override.action}' needs string content.`);
    }
  }
  return { mode, content, sections };
}

function applyOverride(state, override) {
  switch (override.action) {
    case 'remove': return removed();
    case 'replace': return { source: 'text', text: override.content, before: [], after: [] };
    case 'preserve': return vendor();
    case 'append': return { ...state, after: [...state.after, override.content] };
    case 'prepend': return { ...state, before: [override.content, ...state.before] };
    default: throw new TypeError(`Unknown systemMessage action '${override.action}'.`);
  }
}

/**
 * Merges system-message layers in order. `layers` are `{ label, value }`, where
 * `value` is a string (extra content) or `{ mode?, content?, sections? }`.
 * A `replace`-mode layer removes every section and earlier content, so its
 * content becomes the whole message.
 */
export function mergeSystemMessageLayers(base, layers) {
  const merged = {
    sections: Object.fromEntries(Object.entries(base?.sections || {}).map(([id, state]) => [id, { ...state }])),
    content: [...(base?.content || [])],
  };
  for (const { label, value } of layers) {
    const layer = normalizeLayer(value, label);
    if (!layer) continue;
    if (layer.mode === 'replace') {
      for (const id of SYSTEM_MESSAGE_SECTIONS) merged.sections[id] = removed();
      merged.content = [];
    }
    for (const [id, override] of Object.entries(layer.sections)) {
      merged.sections[id] = applyOverride(merged.sections[id] || vendor(), override);
    }
    if (layer.content) merged.content.push(layer.content);
  }
  return merged;
}

const joinParts = parts => parts.filter(part => typeof part === 'string' && part.length > 0).join('\n\n');

/** Renders a merged message as a Copilot SDK `customize` config. Layer content is placed at the end of the prompt. */
export function copilotSystemMessage(merged) {
  const sections = {};
  const states = { ...merged.sections };
  if (merged.content.length > 0) {
    const last = states.last_instructions || vendor();
    states.last_instructions = { ...last, after: [...last.after, ...merged.content] };
  }
  for (const [id, state] of Object.entries(states)) {
    const { before, after } = state;
    if (state.source === 'removed') {
      sections[id] = before.length || after.length
        ? { action: 'replace', content: joinParts([...before, ...after]) }
        : { action: 'remove' };
    } else if (state.source === 'text') {
      sections[id] = { action: 'replace', content: joinParts([...before, state.text, ...after]) };
    } else if (state.filter || before.length || after.length) {
      const { filter } = state;
      sections[id] = { action: current => joinParts([...before, filter ? filter(current) : current, ...after]) };
    } else {
      sections[id] = { action: 'preserve' };
    }
  }
  return { mode: 'customize', sections };
}

/**
 * Renders the text layers added, in section order, for backends that can only
 * append instructions. Removals cannot be expressed there and are ignored.
 */
export function appendedSystemMessage(merged) {
  const known = SYSTEM_MESSAGE_SECTIONS.filter(id => merged.sections[id]);
  const extra = Object.keys(merged.sections).filter(id => !SYSTEM_MESSAGE_SECTIONS.includes(id));
  const parts = [];
  for (const id of [...known, ...extra]) {
    const state = merged.sections[id];
    parts.push(...state.before);
    if (state.source === 'text') parts.push(state.text);
    parts.push(...state.after);
  }
  return joinParts([...parts, ...merged.content]);
}
