// Hand-authored type declarations for the CopilotRuntime adapter.
//
// floe-runtime is authored in plain ESM (.mjs); these declarations exist so a
// TypeScript consumer (e.g. Floe's bridge) can drive the official Copilot SDK through
// the same public surface documented in the README without `any`. They cover
// only the public methods and event shapes a consumer uses - internal helpers
// (#trackToolCall, #finishTurn, respond/publish, session registries) are not
// part of the contract and are intentionally omitted.
import { EventEmitter } from 'node:events';

export function defineTool<T = unknown>(name: string, config: {
  description?: string;
  parameters?: Record<string, unknown>;
  handler?: (args: T, invocation: { sessionId: string; toolCallId: string; toolName: string; signal?: AbortSignal }) => unknown | Promise<unknown>;
  skipPermission?: boolean;
  defer?: 'auto' | 'never';
}): HostTool;

export type EngineAuthentication = 'unknown' | 'signed_out' | 'signed_in' | 'not_required';
export type EngineAccess = 'unknown' | 'entitled' | 'not_entitled' | 'policy_blocked';
export type EngineReachability = 'unknown' | 'reachable' | 'unreachable';

export interface EngineAccountState {
  engine: 'copilot';
  phase: 'checking' | 'ready' | 'action_required' | 'unavailable';
  authentication: EngineAuthentication;
  access: EngineAccess;
  reachability: EngineReachability;
  account?: { label: string; host?: string };
  action?: 'sign_in' | 'check_subscription' | 'contact_admin' | 'retry';
  message: string;
  checked_at: string;
  revision: number;
}

export interface SignInProgress {
  operationId: string;
  engine: 'copilot';
  status: 'starting' | 'waiting_for_person' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
}

export interface CopilotEngineAccountAdapterOptions {
  clientFactory?: (options: Record<string, unknown>) => unknown | Promise<unknown>;
  clientOptions?: Record<string, unknown>;
  cliPath?: string;
  environment?: Record<string, string | undefined>;
  spawnProcess?: (...args: any[]) => any;
  now?: () => string;
  operationId?: () => string;
}

export function copilotChildEnvironment(
  environment?: Record<string, string | undefined>,
): Record<string, string | undefined>;

export class CopilotEngineAccountAdapter extends EventEmitter {
  constructor(options?: CopilotEngineAccountAdapterOptions);
  currentState(): EngineAccountState;
  check(): Promise<EngineAccountState>;
  signIn(options?: { mode?: 'browser' | 'device' }): Promise<{ id: string }>;
  cancelSignIn(id: string): Promise<void>;
  close(): Promise<void>;
  on(event: 'state', listener: (state: EngineAccountState) => void): this;
  on(event: 'sign_in', listener: (progress: SignInProgress) => void): this;
  on(event: 'diagnostic', listener: (text: string) => void): this;
}

export interface RuntimeStartInfo {
  agentCapabilities?: Record<string, unknown>;
  authMethods?: unknown[];
  [key: string]: unknown;
}

/** Prompt payload for a single turn. Either `prompt` or losslessly mapped SDK
 * blocks. Unsupported blocks fail before the message is sent. `schema` opts
 * into client-side structured-output extraction; omit it for a raw-text turn. */
export interface RunInput {
  prompt?: string;
  schema?: object;
  blocks?: PromptBlock[];
}

export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'file' | 'directory'; path: string; displayName?: string }
  | { type: 'selection'; filePath: string; displayName: string; selection?: { start: { line: number; character: number }; end: { line: number; character: number } }; text?: string }
  | { type: 'blob' | 'image'; data: string; mimeType: string; displayName?: string };
export interface RunSettings {
  model?: string;
  timeoutMs?: number;
  systemMessage?: SystemMessageConfig | string;
  tools?: HostTool[];
  availableTools?: string[];
  excludedTools?: string[];
}

export interface HostTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  handler: (args: unknown, invocation: { sessionId: string; toolCallId: string; toolName: string; signal?: AbortSignal }) => unknown | Promise<unknown>;
  skipPermission?: boolean;
  defer?: 'auto' | 'never';
}

export type SystemMessageConfig =
  | { mode?: 'append'; content?: string }
  | { mode: 'customize'; content?: string; sections?: Record<string, { action: string; content?: string }> }
  | { mode: 'replace'; content: string };

/** Reuse hint from a previous run(); pass the prior sessionId to continue it. */
export interface RunContinuation {
  sessionId?: string;
  scope?: string;
  reason?: string;
  resumable?: boolean;
}

export interface RunStartMeta {
  model: string | null;
  runtimeInstance: unknown;
  session: { action: 'fresh' | 'reused' | 'refreshed'; reason: string };
}

export type RunOnStart = (sessionId: string, meta: RunStartMeta) => void | Promise<void>;

/** What run() resolves with. Without an input `schema`, `report === text`. */
export interface RunResult {
  report: unknown;
  text: string;
  sessionId: string;
  turnId: string;
  stopReason: string;
  items: unknown[];
  usage: unknown;
  elapsedMs: number;
}

export interface PermissionRequestOption {
  id: string;
  decision: string;
  label: string;
}

export interface PermissionRequest {
  runtime: string;
  sessionId: string;
  id: string | null;
  title: string;
  kind: string;
  options: PermissionRequestOption[];
  raw: unknown;
}

export type PermissionDecision =
  | 'allow_once'
  | 'reject_once'
  | 'cancel';

export interface ToolPolicyRefusal {
  code?: 'tool_policy_denied' | 'tool_policy_cancelled';
  rule_id?: string | null;
  reason: string;
}

export type PermissionPolicyDecision =
  | PermissionDecision
  | { decision: PermissionDecision; refusal?: ToolPolicyRefusal };

export interface CopilotToolPolicyFacts {
  paths: string[];
  urls: string[];
  requestSandboxBypass: boolean;
  argumentDigest: string;
  [key: string]: unknown;
}

export interface CopilotPermissionRequest extends PermissionRequest {
  operationId: string | null;
  nativeToolCandidates: string[];
  manifestVersion: string;
  facts: CopilotToolPolicyFacts;
}

export const COPILOT_TOOL_MANIFEST_VERSION: string;
export const COPILOT_BUILTIN_TOOL_MANIFEST: Readonly<Record<string, Readonly<Record<string, Readonly<{
  operationId: string;
  permissionKind: string;
}>>>>>;

export interface CopilotRuntimeOptions {
  model?: string;
  timeoutMs?: number;
  quiesceTimeoutMs?: number;
  client?: unknown;
  clientFactory?: (options: Record<string, unknown>) => unknown;
  clientOptions?: Record<string, unknown>;
  systemMessage?: SystemMessageConfig | string;
  tools?: HostTool[];
  availableTools?: string[];
  excludedTools?: string[];
  permissionPolicy?: (request: CopilotPermissionRequest) => PermissionPolicyDecision | Promise<PermissionPolicyDecision>;
  defaultPermissionDecision?: 'reject_once';
  unhandledRequestTimeoutMs?: number;
}

export interface CopilotCapabilities extends Record<string, boolean> {
  setModel: true;
  releaseSession: true;
  setMode: false;
  setPermissions: false;
  setGoal: false;
  compact: false;
  usage: false;
  steer: false;
  fork: false;
  listSessions: true;
  resume: true;
  streaming: true;
  richPrompt: true;
  availableCommands: false;
  fleetMode: false;
  scheduleRecurring: false;
  scheduleOnce: false;
  directTools: true;
  systemMessage: true;
}

/** Backend-neutral tool/command execution event (README: "Activity events"). */
export interface ActivityEvent {
  runtime: string;
  sessionId: string;
  turnId: string | null;
  id: string;
  kind: string;
  status: 'started' | 'completed' | 'failed';
  title: string;
  command: string | null;
  startedAt: number;
  endedAt: number | null;
  raw: unknown;
}

export interface TurnEvent {
  runtime: string;
  sessionId: string;
  turnId: string;
  phase: 'started' | 'completed' | 'failed' | 'interrupted';
  stopReason?: string;
}

export interface UsageEvent {
  runtime: string;
  sessionId: string;
  used?: unknown;
  size?: unknown;
  cost?: unknown;
}

export class CopilotRuntime extends EventEmitter {
  constructor(options?: CopilotRuntimeOptions);
  readonly model?: string;
  capabilities(): CopilotCapabilities;
  start(): Promise<RuntimeStartInfo>;
  models(cwd?: string): Promise<Array<Record<string, unknown>>>;
  run(
    role: string,
    input: RunInput,
    cwd: string,
    onStart?: RunOnStart,
    settings?: RunSettings,
    continuation?: RunContinuation,
  ): Promise<RunResult>;
  setModel(sessionId: string, modelId: string): Promise<unknown>;
  interrupt(sessionId: string): Promise<void>;
  quiesce(sessionId: string): Promise<void>;
  retire(sessionId: string): Promise<{ status: string; reason?: string }>;
  resume(sessionId: string, cwd: string): Promise<string>;
  availableCommands(sessionId: string): never;
  close(): Promise<void>;

  on(event: 'activity', listener: (event: ActivityEvent) => void): this;
  on(event: 'turn', listener: (event: TurnEvent) => void): this;
  on(event: 'usage', listener: (event: UsageEvent) => void): this;
  on(event: 'diagnostic', listener: (text: string) => void): this;
  on(event: 'stream' | 'request' | 'ready' | 'lost' | 'notification', listener: (...args: unknown[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
