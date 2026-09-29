import { createHash, randomUUID } from 'node:crypto';

export const COPILOT_TOOL_MANIFEST_VERSION = 'copilot-cli-1.0.83-win32-v3';

const DEFAULT_CATALOG = 'default';
const CODEX_CATALOG = 'codex';

const descriptor = (operationId, catalogs = [DEFAULT_CATALOG, CODEX_CATALOG]) =>
  Object.freeze({ operationId, catalogs: Object.freeze(catalogs) });

export const COPILOT_BUILTIN_TOOL_MANIFEST = Object.freeze({
  win32: Object.freeze({
    powershell: descriptor('engine.tool.process.execute'),
    read_powershell: descriptor('engine.tool.process.execute'),
    stop_powershell: descriptor('engine.tool.process.execute'),
    list_powershell: descriptor('engine.tool.process.execute'),
    view: descriptor('engine.tool.filesystem.read'),
    grep: descriptor('engine.tool.filesystem.read', [DEFAULT_CATALOG]),
    rg: descriptor('engine.tool.filesystem.read', [CODEX_CATALOG]),
    glob: descriptor('engine.tool.filesystem.read'),
    create: descriptor('engine.tool.filesystem.write', [DEFAULT_CATALOG]),
    edit: descriptor('engine.tool.filesystem.write', [DEFAULT_CATALOG]),
    apply_patch: descriptor('engine.tool.filesystem.write', [CODEX_CATALOG]),
    web_fetch: descriptor('engine.tool.network.fetch'),
  }),
});

function fault(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function stringArray(value) {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function requireObject(value, toolName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fault('copilot_tool_arguments_invalid', `Copilot tool '${toolName}' did not provide object arguments.`);
  }
  return value;
}

function requireString(value, field, toolName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fault('copilot_tool_arguments_invalid', `Copilot tool '${toolName}' did not provide '${field}'.`);
  }
  return value;
}

function catalogForModel(model) {
  return typeof model === 'string' && /(?:^|[-_.])codex(?:$|[-_.])/i.test(model)
    ? CODEX_CATALOG
    : DEFAULT_CATALOG;
}

export function copilotToolCatalogForModel(model, platform = process.platform) {
  const manifest = COPILOT_BUILTIN_TOOL_MANIFEST[platform] || {};
  const catalog = catalogForModel(model);
  return Object.freeze(
    Object.keys(manifest)
      .filter(name => manifest[name].catalogs.includes(catalog))
      .sort(),
  );
}

export function resolveCopilotToolSelection({
  tools = [],
  availableTools,
  excludedTools,
  model,
  platform = process.platform,
} = {}) {
  if (excludedTools?.length) {
    throw fault('copilot_tool_selection_invalid', 'Copilot uses an exact allowlist; excludedTools is not supported.');
  }
  const manifest = COPILOT_BUILTIN_TOOL_MANIFEST[platform] || {};
  const activeBuiltins = new Set(copilotToolCatalogForModel(model, platform));
  const customNames = new Set();
  for (const tool of tools) {
    if (customNames.has(tool.name)) {
      throw fault('copilot_tool_selection_invalid', `Copilot tool '${tool.name}' is registered more than once.`);
    }
    if (Object.hasOwn(manifest, tool.name)) {
      throw fault('copilot_tool_selection_invalid', `Custom tool '${tool.name}' conflicts with a governed Copilot built-in.`);
    }
    customNames.add(tool.name);
  }

  const requested = availableTools ?? [
    ...activeBuiltins,
    ...customNames,
  ].map(name => `${customNames.has(name) ? 'custom' : 'builtin'}:${name}`);
  if (!Array.isArray(requested)) {
    throw fault('copilot_tool_selection_invalid', 'Copilot availableTools must be an exact array.');
  }

  const filters = [];
  const expectedNames = new Set();
  const builtins = new Map();
  for (const entry of requested) {
    if (typeof entry !== 'string' || !entry.trim() || entry.includes('*')) {
      throw fault('copilot_tool_selection_invalid', `Copilot tool filter '${String(entry)}' is not an exact tool name.`);
    }
    let source;
    let name;
    if (entry.startsWith('builtin:') || entry.startsWith('custom:')) {
      [source, name] = entry.split(':', 2);
    } else if (entry.includes(':')) {
      throw fault('copilot_tool_selection_invalid', `Copilot tool source in '${entry}' is not allowed.`);
    } else if (customNames.has(entry)) {
      source = 'custom';
      name = entry;
    } else {
      throw fault('copilot_tool_selection_invalid', `Copilot built-in '${entry}' must be source-qualified and present in the pinned manifest.`);
    }

    if (source === 'custom' && !customNames.has(name)) {
      throw fault('copilot_tool_selection_invalid', `Copilot custom tool '${name}' is not registered.`);
    }
    if (source === 'builtin') {
      const builtIn = manifest[name];
      if (!builtIn) {
        throw fault('copilot_tool_selection_invalid', `Copilot built-in '${name}' is not governed by manifest '${COPILOT_TOOL_MANIFEST_VERSION}'.`);
      }
      if (!activeBuiltins.has(name)) continue;
      builtins.set(name, builtIn);
    }
    const qualified = `${source}:${name}`;
    if (!filters.includes(qualified)) filters.push(qualified);
    expectedNames.add(name);
  }

  return Object.freeze({
    filters: Object.freeze(filters),
    expectedNames: Object.freeze([...expectedNames].sort()),
    builtins,
    customNames: Object.freeze([...customNames].sort()),
    catalog: catalogForModel(model),
    manifestVersion: COPILOT_TOOL_MANIFEST_VERSION,
  });
}

function parsePatch(patch) {
  if (typeof patch !== 'string') {
    throw fault('copilot_tool_arguments_invalid', 'Copilot apply_patch did not provide a patch string.');
  }
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== '*** Begin Patch') {
    throw fault('copilot_tool_arguments_invalid', 'Copilot apply_patch is missing the begin marker.');
  }
  const changes = [];
  while (lines.length && lines[0] !== '*** End Patch') {
    const header = lines.shift();
    let match;
    if ((match = /^\*\*\* Add File: (.+)$/.exec(header))) {
      const content = [];
      while (lines.length && !lines[0].startsWith('*** ')) {
        const line = lines.shift();
        if (!line.startsWith('+')) throw fault('copilot_tool_arguments_invalid', 'Copilot apply_patch add lines must start with +.');
        content.push(line.slice(1));
      }
      if (content.length === 0) throw fault('copilot_tool_arguments_invalid', 'Copilot apply_patch add hunk is empty.');
      changes.push({ kind: 'add', path: match[1], content: content.join('\n') });
    } else if ((match = /^\*\*\* Delete File: (.+)$/.exec(header))) {
      changes.push({ kind: 'delete', path: match[1] });
    } else if ((match = /^\*\*\* Update File: (.+)$/.exec(header))) {
      const change = { kind: 'update', path: match[1], moveTo: null, diff: [] };
      if (lines[0]?.startsWith('*** Move to: ')) {
        change.moveTo = requireString(lines.shift().slice('*** Move to: '.length), 'moveTo', 'apply_patch');
      }
      while (lines.length && lines[0] !== '*** End Patch' && !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[0])) {
        const line = lines.shift();
        if (line !== '*** End of File' && !line.startsWith('@@') && !/^[+ -]/.test(line)) {
          throw fault('copilot_tool_arguments_invalid', `Copilot apply_patch contains an invalid update line: '${line}'.`);
        }
        change.diff.push(line);
      }
      if (change.diff.length === 0) throw fault('copilot_tool_arguments_invalid', 'Copilot apply_patch update hunk is empty.');
      changes.push(change);
    } else {
      throw fault('copilot_tool_arguments_invalid', `Copilot apply_patch contains an unknown hunk: '${header}'.`);
    }
  }
  if (lines.shift() !== '*** End Patch' || lines.some(line => line !== '')) {
    throw fault('copilot_tool_arguments_invalid', 'Copilot apply_patch is missing the end marker or has trailing content.');
  }
  if (changes.length === 0) throw fault('copilot_tool_arguments_invalid', 'Copilot apply_patch contains no changes.');
  return changes;
}

function toolFacts(toolName, toolArgs) {
  const common = { paths: [], urls: [], requestSandboxBypass: false, arguments: toolArgs };
  if (toolName === 'apply_patch') {
    const changes = parsePatch(toolArgs);
    return {
      ...common,
      paths: changes.flatMap(change => [change.path, ...(change.moveTo ? [change.moveTo] : [])]),
      patch: toolArgs,
      changes,
    };
  }

  const args = requireObject(toolArgs, toolName);
  if (toolName === 'powershell') {
    const command = requireString(args.command, 'command', toolName);
    return { ...common, fullCommandText: command, commandSegments: [{ identifier: null, fullCommandText: command }] };
  }
  if (toolName === 'view') {
    return { ...common, paths: [requireString(args.path, 'path', toolName)] };
  }
  if (toolName === 'grep' || toolName === 'rg' || toolName === 'glob') {
    return { ...common, paths: stringArray(args.paths) };
  }
  if (toolName === 'create') {
    const path = requireString(args.path, 'path', toolName);
    if (typeof args.file_text !== 'string') throw fault('copilot_tool_arguments_invalid', "Copilot tool 'create' did not provide 'file_text'.");
    return { ...common, paths: [path], createsFile: true, fileText: args.file_text };
  }
  if (toolName === 'edit') {
    const path = requireString(args.path, 'path', toolName);
    if (typeof args.old_str !== 'string' || typeof args.new_str !== 'string') {
      throw fault('copilot_tool_arguments_invalid', "Copilot tool 'edit' did not provide 'old_str' and 'new_str'.");
    }
    return { ...common, paths: [path], createsFile: false, oldText: args.old_str, newText: args.new_str };
  }
  if (toolName === 'web_fetch') {
    return { ...common, urls: [requireString(args.url, 'url', toolName)] };
  }
  return common;
}

export function normalizeCopilotToolCall(input, invocation, selection, toolCallId) {
  const toolName = requireString(input?.toolName, 'toolName', 'unknown');
  const descriptor = selection.builtins.get(toolName);
  if (!descriptor) {
    throw fault('copilot_tool_not_governed', `Copilot tool '${toolName}' is not in the active governed catalog.`);
  }
  const facts = toolFacts(toolName, input.toolArgs);
  return {
    runtime: 'copilot',
    sessionId: invocation?.sessionId || input?.sessionId || '',
    id: toolCallId,
    title: toolName,
    kind: descriptor.operationId,
    operationId: descriptor.operationId,
    nativeToolCandidates: [toolName],
    manifestVersion: selection.manifestVersion,
    facts: { ...facts, argumentDigest: digest({ toolName, arguments: input.toolArgs }) },
    options: [
      { id: 'approve', decision: 'allow_once', label: 'Allow once' },
      { id: 'reject', decision: 'reject_once', label: 'Reject' },
    ],
    raw: input,
  };
}

export const normalizeCopilotPermissionRequest = normalizeCopilotToolCall;

function structuredRefusal(outcome, request) {
  const decision = typeof outcome === 'string' ? outcome : outcome?.decision;
  const supplied = typeof outcome === 'object' && outcome?.refusal ? outcome.refusal : {};
  return {
    code: decision === 'cancel' ? 'tool_policy_cancelled' : 'tool_policy_denied',
    tool_call_id: request?.id || null,
    operation_id: request?.operationId || null,
    rule_id: supplied.rule_id || null,
    reason: supplied.reason || (decision === 'cancel' ? 'Floe cancelled this operation.' : 'Floe denied this operation.'),
  };
}

function denied(outcome, request) {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: JSON.stringify(structuredRefusal(outcome, request)),
  };
}

export function createCopilotToolHook({
  selection,
  policy,
  timeoutMs,
  toolCallId = () => `tool-call-${randomUUID()}`,
  onDiagnostic = () => {},
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Copilot tool policy timeout must be a positive finite number.');
  }
  return async (input, invocation = {}) => {
    let normalized;
    try {
      if (selection.customNames.includes(input?.toolName)) return { permissionDecision: 'allow' };
      normalized = normalizeCopilotToolCall(input, invocation, selection, toolCallId());
      if (!policy) return { permissionDecision: 'allow' };

      let timer;
      let outcome;
      try {
        outcome = await Promise.race([
          Promise.resolve(policy(normalized)),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = fault('tool_policy_timeout', `Floe did not decide tool call '${normalized.id}' before the policy timeout.`);
              reject(error);
            }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const decision = typeof outcome === 'string' ? outcome : outcome?.decision;
      if (decision === 'allow_once') return { permissionDecision: 'allow' };
      if (decision === 'reject_once' || decision === 'cancel') return denied(outcome, normalized);
      return denied({
        decision: 'reject_once',
        refusal: { reason: `Floe returned unsupported tool decision '${String(decision)}'.` },
      }, normalized);
    } catch (error) {
      onDiagnostic(`Copilot tool policy failed closed: ${error.message}`);
      return denied({
        decision: 'reject_once',
        refusal: { reason: `Floe could not safely evaluate this tool call: ${error.message}` },
      }, normalized);
    }
  };
}

export async function prepareCopilotToolSession(session, selection, workingDirectory) {
  const permissions = session?.rpc?.permissions;
  const tools = session?.rpc?.tools;
  if (!permissions || !tools) {
    throw fault('copilot_tool_catalog_unavailable', 'Copilot did not expose its session tool and permission controls.');
  }

  await permissions.configure({
    approveAllToolPermissionRequests: false,
    approveAllReadPermissionRequests: false,
    rules: { approved: [], denied: [] },
    paths: {
      unrestricted: true,
      additionalDirectories: [],
      includeTempDirectory: true,
      workspacePath: workingDirectory,
    },
    urls: { unrestricted: true, initialAllowed: [] },
  });
  await permissions.setApproveAll({ enabled: false });
  const mode = await permissions.setMode({ mode: 'manual' });
  if (mode?.success === false || (mode?.mode && mode.mode !== 'manual')) {
    throw fault('copilot_permission_mode_unsafe', 'Copilot refused manual permission mode.');
  }
  await permissions.resetSessionApprovals({ includeLocation: false });
  await tools.initializeAndValidate();
  const metadata = await tools.getCurrentMetadata();
  if (!Array.isArray(metadata?.tools)) {
    throw fault('copilot_tool_catalog_unavailable', 'Copilot did not return its initialized tool catalog.');
  }

  const actual = [...new Set(metadata.tools.map(tool => tool?.name).filter(name => typeof name === 'string'))].sort();
  const expected = [...selection.expectedNames];
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw fault(
      'copilot_tool_catalog_drift',
      `Copilot tool catalog drifted from '${selection.manifestVersion}/${selection.catalog}': expected [${expected.join(', ')}], received [${actual.join(', ')}].`,
    );
  }
  return { manifestVersion: selection.manifestVersion, catalog: selection.catalog, tools: actual };
}
