// @invariant CopilotRuntime requires caller-owned SDK session storage and the
// readiness-confirmed user OAuth identity before any session can run.
//
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

export interface AccountState {
  engine: string;
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

export interface EngineAccountState extends AccountState {
  engine: 'copilot';
}

export type AccountSignInProvider = 'github' | 'github-enterprise-cloud' | 'microsoft-entra';

export interface SignInAccountChoice {
  selectionId: string;
  login: string;
  host: string;
  provider: string;
}

export type SignInUserAction =
  | { kind: 'open_url'; url: string }
  | { kind: 'input_required'; prompt: string }
  | { kind: 'needs_interaction' }
  | { kind: 'awaiting' }
  | { kind: 'account_selection'; accounts: SignInAccountChoice[] }
  | { kind: 'plaintext_consent' };

export type AccountSignInStatus =
  | 'starting'
  | 'waiting_for_person'
  | 'awaiting_input'
  | 'needs_interaction'
  | 'needs_account_selection'
  | 'needs_plaintext_consent'
  | 'succeeded'
  | 'declined'
  | 'failed'
  | 'cancelled';

export interface AccountSignInProgress {
  operationId: string;
  engine: string;
  provider: string;
  status: AccountSignInStatus;
  message: string;
  action?: SignInUserAction;
}

export interface SignInProgress extends AccountSignInProgress {
  engine: 'copilot';
  provider: AccountSignInProvider;
}

export type SignInAnswer =
  | { kind: 'continue' }
  | { kind: 'input'; value: string }
  | { kind: 'select_account'; selectionId: string }
  | { kind: 'plaintext_consent'; accepted: boolean };

export interface AccountSignInAdapter {
  currentState(): AccountState;
  check(): Promise<AccountState>;
  signIn(options?: { provider?: AccountSignInProvider; openBrowser?: boolean }): Promise<{ id: string }>;
  continueSignIn(id: string, answer: SignInAnswer): Promise<void>;
  cancelSignIn(id: string): Promise<void>;
  close(): Promise<void>;
  on(event: 'state', listener: (state: AccountState) => void): this;
  on(event: 'sign_in', listener: (progress: AccountSignInProgress) => void): this;
}

export interface CopilotEngineAccountAdapterOptions {
  clientFactory?: (options: Record<string, unknown>) => unknown | Promise<unknown>;
  clientOptions: Record<string, unknown> & { baseDirectory: string };
  cliPath?: string;
  environment?: Record<string, string | undefined>;
  spawnProcess?: (...args: any[]) => any;
  openUrl?: (url: string) => void | Promise<void>;
  now?: () => string;
  operationId?: () => string;
}

export function copilotChildEnvironment(
  environment?: Record<string, string | undefined>,
): Record<string, string | undefined>;

export class CopilotEngineAccountAdapter extends EventEmitter {
  constructor(options: CopilotEngineAccountAdapterOptions);
  currentState(): EngineAccountState;
  check(): Promise<EngineAccountState>;
  signIn(options?: {
    provider?: AccountSignInProvider;
    openBrowser?: boolean;
    /** @deprecated Use provider and openBrowser. `device` retains the CLI compatibility path. */
    mode?: 'browser' | 'device';
  }): Promise<{ id: string }>;
  continueSignIn(id: string, answer: SignInAnswer): Promise<void>;
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
/**
 * Copilot reasoning effort level. Each model supports its own subset (see `models()` →
 * `supportedReasoningEfforts`); `none` is offered by some GPT models.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RunSettings {
  model?: string;
  /**
   * Reasoning effort for this run. Omit for the model's default (or, on a continued session, the
   * session's current effort). A level the model does not support is refused with `copilot_effort_unavailable`.
   */
  effort?: ReasoningEffort;
  timeoutMs?: number;
  progressTimeoutMs?: number;
  systemMessage?: SystemMessageConfig | string;
  /** Automatic compaction for a new or resumed session; overrides the runtime option. See README "Compaction". */
  infiniteSessions?: InfiniteSessionsSettings;
  tools?: HostTool[];
  availableTools?: string[];
  excludedTools?: string[];
}

/** Copilot SDK automatic-compaction settings. Omitted fields use the SDK defaults. */
export interface InfiniteSessionsSettings {
  /** `false` turns automatic compaction off. SDK default: true. */
  enabled?: boolean;
  /** Context use (above 0, at most 1) at which background compaction starts. SDK default: 0.80. */
  backgroundCompactionThreshold?: number;
  /** Context use (above 0, at most 1) at which the session waits for compaction. SDK default: 0.95. */
  bufferExhaustionThreshold?: number;
}

/** What `compact()` resolves with. Fields the backend does not report are null. */
export interface CompactResult {
  runtime: 'copilot' | 'codex';
  sessionId: string;
  success: boolean | null;
  tokensRemoved: number | null;
  messagesRemoved: number | null;
  summary: string | null;
  error: string | null;
}

/** Backend-neutral compaction event (README: "Compaction"). */
export interface CompactionEvent {
  runtime: 'copilot' | 'codex';
  sessionId: string;
  phase: 'started' | 'completed' | 'failed';
  /** Copilot SDK trigger: manual, threshold, context_limit_retry, memory_pressure or model_switch. */
  trigger: string | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
  tokensRemoved: number | null;
  messagesRemoved: number | null;
  focus: string | null;
  summary: string | null;
  error: string | null;
  raw: unknown;
}

export interface HostTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  handler: (args: unknown, invocation: { sessionId: string; toolCallId: string; toolName: string; signal?: AbortSignal }) => unknown | Promise<unknown>;
  skipPermission?: boolean;
  defer?: 'auto' | 'never';
}

/** Floe system-message section ids. `identity` groups preamble, tone and tool_efficiency. */
export type SystemMessageSection =
  | 'preamble' | 'tone' | 'tool_efficiency' | 'identity' | 'code_change_rules' | 'guidelines' | 'safety'
  | 'environment_context' | 'tool_instructions' | 'custom_instructions' | 'runtime_instructions' | 'last_instructions';

export type SystemMessageSectionOverride =
  | { action: 'remove' | 'preserve' }
  | { action: 'replace' | 'append' | 'prepend'; content: string };

/**
 * One system-message layer (application or actor). A string is extra content.
 * Layers stack on the Floe runtime base: each may change any section. `replace`
 * mode removes every section and earlier content, so its content is the whole message.
 */
export type SystemMessageConfig = {
  mode?: 'append' | 'customize' | 'replace';
  content?: string;
  sections?: Partial<Record<SystemMessageSection | (string & {}), SystemMessageSectionOverride>>;
};

/** Reuse hint from a previous run(); pass the prior sessionId to continue it. */
export interface RunContinuation {
  sessionId?: string;
  scope?: string;
  reason?: string;
  resumable?: boolean;
}

export interface RunStartMeta {
  model: string | null;
  /** The effort the session is set to, or null when Copilot's model default applies. */
  effort: string | null;
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
  /** The effort Copilot reported using, else the effort the session was set to, else null. */
  effort: string | null;
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
  arguments: unknown;
  argumentDigest: string;
  fullCommandText?: string;
  commandSegments?: Array<{ identifier: string | null; fullCommandText: string }>;
  createsFile?: boolean;
  fileText?: string;
  oldText?: string;
  newText?: string;
  patch?: string;
  changes?: Array<{
    kind: 'add' | 'update' | 'delete';
    path: string;
    moveTo?: string | null;
    content?: string;
    diff?: string[];
  }>;
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
  catalogs: readonly string[];
}>>>>>;

export type CopilotToolCatalog = 'default' | 'codex';
export const COPILOT_TOOL_CATALOGS: readonly CopilotToolCatalog[];

export interface CopilotToolSelection {
  filters: readonly string[];
  /** Exact tool names the session must report, per catalog Copilot may pick. */
  expectedByCatalog: Readonly<Record<CopilotToolCatalog, readonly string[]>>;
  builtins: ReadonlyMap<string, Readonly<{ operationId: string; catalogs: readonly string[] }>>;
  customNames: readonly string[];
  manifestVersion: string;
}

/** Every governed built-in for the platform, across all catalogs. */
export function copilotGovernedBuiltins(platform?: NodeJS.Platform): readonly string[];

/** @deprecated The model does not decide the catalog; use copilotGovernedBuiltins. */
export function copilotToolCatalogForModel(model?: string, platform?: NodeJS.Platform): readonly string[];

export function resolveCopilotToolSelection(options?: {
  tools?: HostTool[];
  availableTools?: string[];
  excludedTools?: string[];
  platform?: NodeJS.Platform;
}): CopilotToolSelection;

export function normalizeCopilotToolCall(
  input: { sessionId?: string; toolName?: string; toolArgs?: unknown },
  invocation: { sessionId?: string },
  selection: CopilotToolSelection,
  toolCallId: string,
): CopilotPermissionRequest;

export const normalizeCopilotPermissionRequest: typeof normalizeCopilotToolCall;

export interface CopilotPreToolHookOutput {
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason?: string;
  modifiedArgs?: unknown;
}

/** One tool call about to run, as seen by `beforeToolUse`. */
export interface CopilotBeforeToolUseCall {
  /** Runtime-assigned id; the same id the permission policy saw. The SDK's own tool call id is not exposed to hooks. */
  id: string;
  toolName: string;
  source: 'builtin' | 'custom';
  args: unknown;
  sessionId: string;
  cwd: string | null;
}

export type CopilotBeforeToolUseResult =
  | { decision: 'allow' }
  | { decision: 'block'; reason?: string }
  | { decision: 'change'; args: unknown };

/** Runs after the permission policy allowed a call. Return nothing to allow. */
export type CopilotBeforeToolUse = (
  call: CopilotBeforeToolUseCall,
) => CopilotBeforeToolUseResult | void | Promise<CopilotBeforeToolUseResult | void>;

export function createCopilotToolHook(options: {
  selection: CopilotToolSelection;
  policy?: (request: CopilotPermissionRequest) => PermissionPolicyDecision | Promise<PermissionPolicyDecision>;
  beforeToolUse?: CopilotBeforeToolUse;
  timeoutMs: number;
  toolCallId?: () => string;
  onDiagnostic?: (message: string) => void;
}): (
  input: { sessionId?: string; toolName?: string; toolArgs?: unknown; workingDirectory?: string },
  invocation?: { sessionId?: string },
) => Promise<CopilotPreToolHookOutput>;

export type CopilotClientSessionOptions = Record<string, unknown> & {
  baseDirectory: string;
  sessionFs?: unknown;
};

export interface ExpectedCopilotAccount {
  label: string;
  host?: string;
}

export type CopilotRuntimeOptions = {
  model?: string;
  timeoutMs?: number;
  quiesceTimeoutMs?: number;
  progressTimeoutMs?: number;
  client?: unknown;
  clientFactory?: (options: Record<string, unknown>) => unknown;
  clientOptions: CopilotClientSessionOptions;
  expectedAccount: ExpectedCopilotAccount;
  systemMessage?: SystemMessageConfig | string;
  tools?: HostTool[];
  availableTools?: string[];
  excludedTools?: string[];
  infiniteSessions?: InfiniteSessionsSettings;
  permissionPolicy?: (request: CopilotPermissionRequest) => PermissionPolicyDecision | Promise<PermissionPolicyDecision>;
  beforeToolUse?: CopilotBeforeToolUse;
  defaultPermissionDecision?: 'allow_once';
  toolPolicyTimeoutMs?: number;
  unhandledRequestTimeoutMs?: number;
};

export interface CopilotCapabilities extends Record<string, boolean> {
  setModel: true;
  releaseSession: true;
  setMode: false;
  setPermissions: false;
  setGoal: false;
  compact: true;
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
  systemMessageSections: true;
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
  constructor(options: CopilotRuntimeOptions);
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
  /**
   * Switches a live session's model and optionally its effort. Without `options.effort` the current
   * effort is kept; a model that cannot use it is refused (`copilot_effort_unavailable`). A switch
   * Copilot rejects (`copilot_model_switch_rejected`) leaves the session unchanged.
   */
  setModel(sessionId: string, modelId: string, options?: { effort?: ReasoningEffort }): Promise<unknown>;
  interrupt(sessionId: string): Promise<void>;
  quiesce(sessionId: string): Promise<void>;
  retire(sessionId: string): Promise<{ status: string; reason?: string }>;
  resume(sessionId: string, cwd: string, settings?: RunSettings): Promise<string>;
  /**
   * Compacts the session's history now. A session not live in this process is resumed first, in
   * `options.cwd` or the working directory Copilot recorded. Refused with `turn_busy` during a turn.
   */
  compact(sessionId: string, focus?: string, options?: { cwd?: string; settings?: RunSettings }): Promise<CompactResult>;
  availableCommands(sessionId: string): never;
  close(): Promise<void>;

  on(event: 'activity', listener: (event: ActivityEvent) => void): this;
  on(event: 'turn', listener: (event: TurnEvent) => void): this;
  on(event: 'usage', listener: (event: UsageEvent) => void): this;
  on(event: 'compaction', listener: (event: CompactionEvent) => void): this;
  on(event: 'diagnostic', listener: (text: string) => void): this;
  on(event: 'stream' | 'request' | 'ready' | 'lost' | 'notification', listener: (...args: unknown[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
