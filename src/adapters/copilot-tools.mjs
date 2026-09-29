import { createHash } from 'node:crypto';

export const COPILOT_TOOL_MANIFEST_VERSION = 'copilot-cli-1.0.83-win32-v2';

export const COPILOT_BUILTIN_TOOL_MANIFEST = Object.freeze({
  win32: Object.freeze({
    powershell: Object.freeze({ operationId: 'engine.tool.process.execute', permissionKind: 'shell' }),
    view: Object.freeze({ operationId: 'engine.tool.filesystem.read', permissionKind: 'read' }),
    grep: Object.freeze({ operationId: 'engine.tool.filesystem.read', permissionKind: 'read' }),
    glob: Object.freeze({ operationId: 'engine.tool.filesystem.read', permissionKind: 'read' }),
    web_fetch: Object.freeze({ operationId: 'engine.tool.network.fetch', permissionKind: 'url' }),
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
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

export function resolveCopilotToolSelection({
  tools = [],
  availableTools,
  excludedTools,
  platform = process.platform,
} = {}) {
  if (excludedTools?.length) {
    throw fault('copilot_tool_selection_invalid', 'Copilot uses an exact allowlist; excludedTools is not supported.');
  }
  const manifest = COPILOT_BUILTIN_TOOL_MANIFEST[platform] || {};
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

  const requested = availableTools ?? [...customNames].map(name => `custom:${name}`);
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
      const descriptor = manifest[name];
      if (!descriptor) {
        throw fault('copilot_tool_selection_invalid', `Copilot built-in '${name}' is not governed by manifest '${COPILOT_TOOL_MANIFEST_VERSION}'.`);
      }
      builtins.set(name, descriptor);
    }
    const qualified = `${source}:${name}`;
    if (!filters.includes(qualified)) filters.push(qualified);
    expectedNames.add(name);
  }

  return Object.freeze({
    filters: Object.freeze(filters),
    expectedNames: Object.freeze([...expectedNames].sort()),
    builtins,
    manifestVersion: COPILOT_TOOL_MANIFEST_VERSION,
  });
}

export function normalizeCopilotPermissionRequest(request, invocation, selection) {
  const kind = request?.kind || 'unknown';
  const nativeToolCandidates = [...selection.builtins]
    .filter(([, descriptor]) => descriptor.permissionKind === kind)
    .map(([name]) => name)
    .sort();
  const operationIds = [...new Set(nativeToolCandidates.map(name => selection.builtins.get(name).operationId))];
  const operationId = operationIds.length === 1 ? operationIds[0] : null;
  const common = {
    paths: [],
    urls: [],
    requestSandboxBypass: request?.requestSandboxBypass === true,
  };
  let facts;
  if (kind === 'shell') {
    facts = {
      ...common,
      fullCommandText: request.fullCommandText,
      commands: Array.isArray(request.commands)
        ? request.commands.map(command => ({ identifier: command.identifier, readOnly: command.readOnly === true }))
        : [],
      commandSegments: Array.isArray(request.commandSegments)
        ? request.commandSegments.map(segment => ({ identifier: segment.identifier, fullCommandText: segment.fullCommandText }))
        : [],
      paths: stringArray(request.possiblePaths),
      urls: Array.isArray(request.possibleUrls)
        ? request.possibleUrls.map(item => item?.url).filter(url => typeof url === 'string')
        : [],
      hasWriteFileRedirection: request.hasWriteFileRedirection === true,
    };
  } else if (kind === 'write') {
    facts = {
      ...common,
      paths: typeof request.fileName === 'string' ? [request.fileName] : [],
      createsFile: typeof request.newFileContents === 'string',
      contentDigest: digest({ diff: request.diff ?? null, newFileContents: request.newFileContents ?? null }),
    };
  } else if (kind === 'read') {
    facts = { ...common, paths: typeof request.path === 'string' ? [request.path] : [] };
  } else if (kind === 'url') {
    facts = {
      ...common,
      urls: typeof request.url === 'string' ? [request.url] : [],
      redirectedFrom: typeof request.redirectedFrom === 'string' ? request.redirectedFrom : null,
    };
  } else {
    facts = common;
  }

  return {
    runtime: 'copilot',
    sessionId: invocation?.sessionId || '',
    id: request?.toolCallId || request?.requestId || null,
    title: nativeToolCandidates.length === 1 ? nativeToolCandidates[0] : `Copilot ${kind} tool`,
    kind,
    operationId,
    nativeToolCandidates,
    manifestVersion: selection.manifestVersion,
    facts: { ...facts, argumentDigest: digest(facts) },
    options: [
      { id: 'approve', decision: 'allow_once', label: 'Allow once' },
      { id: 'reject', decision: 'reject_once', label: 'Reject' },
    ],
    raw: request,
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
      unrestricted: false,
      additionalDirectories: [],
      includeTempDirectory: false,
      workspacePath: workingDirectory,
    },
    urls: { unrestricted: false, initialAllowed: [] },
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
      `Copilot tool catalog drifted from '${selection.manifestVersion}': expected [${expected.join(', ')}], received [${actual.join(', ')}].`,
    );
  }
  return { manifestVersion: selection.manifestVersion, tools: actual };
}
