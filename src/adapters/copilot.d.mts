// Hand-authored type declarations for the CopilotRuntime adapter.
//
// floe-runtime is authored in plain ESM (.mjs); these declarations exist so a
// TypeScript consumer (e.g. Floe's bridge) can drive `copilot --acp` through
// the same public surface documented in the README without `any`. They cover
// only the public methods and event shapes a consumer uses - internal helpers
// (#trackToolCall, #finishTurn, respond/publish, session registries) are not
// part of the contract and are intentionally omitted.
import { EventEmitter } from 'node:events';

export interface RuntimeStartInfo {
  agentCapabilities?: Record<string, unknown>;
  authMethods?: unknown[];
  [key: string]: unknown;
}

/** Prompt payload for a single turn. Either `prompt` (built text) or `blocks`
 * (structured ACP content blocks passed straight through). `schema` opts into
 * client-side structured-output extraction; omit it for a raw-text turn. */
export interface RunInput {
  prompt?: string;
  schema?: object;
  blocks?: Array<Record<string, unknown>>;
}

/** A name/value pair, used for MCP stdio env and HTTP/SSE headers. */
export interface McpNameValue {
  name: string;
  value: string;
}

/**
 * An ACP MCP server connection descriptor, forwarded verbatim to the agent in
 * `session/new` / `session/load` / `session/resume`. Shapes are exactly those
 * defined by the Agent Client Protocol session-setup spec ("MCP Servers"):
 *   - stdio (every agent MUST support it) has no `type` discriminator;
 *   - http/sse are optional and gated on `mcpCapabilities.http` / `.sse`.
 * @see https://agentclientprotocol.com/protocol/v1/session-setup
 */
export type McpServer =
  | {
      /** Human-readable server identifier. */
      name: string;
      /** Absolute path to the MCP server executable. */
      command: string;
      /** Command-line arguments passed to the server. */
      args: string[];
      /** Environment variables set when launching the server. */
      env?: McpNameValue[];
    }
  | {
      type: 'http';
      name: string;
      url: string;
      headers: McpNameValue[];
    }
  | {
      type: 'sse';
      name: string;
      url: string;
      headers: McpNameValue[];
    };

export interface RunSettings {
  model?: string;
  timeoutMs?: number;
  mcpServers?: McpServer[];
}

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
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | 'cancel';

export interface CopilotRuntimeOptions {
  executable?: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
  permissionPolicy?: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
  defaultPermissionDecision?: PermissionDecision;
  unhandledRequestTimeoutMs?: number;
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
  capabilities(): Record<string, boolean>;
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
  resume(sessionId: string, cwd: string, mcpServers?: McpServer[], opts?: { goal?: string }): Promise<string>;
  close(): Promise<void>;

  on(event: 'activity', listener: (event: ActivityEvent) => void): this;
  on(event: 'turn', listener: (event: TurnEvent) => void): this;
  on(event: 'usage', listener: (event: UsageEvent) => void): this;
  on(event: 'diagnostic', listener: (text: string) => void): this;
  on(event: 'stream' | 'request' | 'ready' | 'lost' | 'notification', listener: (...args: unknown[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
