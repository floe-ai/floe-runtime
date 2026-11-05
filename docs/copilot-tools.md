# Copilot tools and features in floe-runtime

What a Copilot session run through `CopilotRuntime` can and cannot use, and why.

Checked against Copilot CLI 1.0.95 (`@github/copilot-sdk` 1.0.19), manifest
`copilot-cli-1.0.95-win32-linux-v4`. The tool lists come from live sessions
(`tools.getCurrentMetadata`) with every optional feature turned on.

`test/copilot-tools-doc.test.mjs` fails if this file and
`COPILOT_BUILTIN_TOOL_MANIFEST` stop matching.

## How tools are controlled

floe-runtime uses an exact allowlist, not a block list. A Copilot tool works
only if it is in the governed manifest (`COPILOT_BUILTIN_TOOL_MANIFEST`) or
is one of the app's own tools (`defineTool`). Everything else is blocked:

- **Blocked:** any tool listed below, any MCP-server tool, and any tool a
  future Copilot version adds.
- **At startup:** the session must report exactly the expected tools. If
  Copilot adds, drops or renames a tool, the session fails with
  `copilot_tool_catalog_drift` before any prompt is sent.
- **Before every call:** every allowed built-in passes through the
  `permissionPolicy` and `beforeToolUse` checks.

An app can narrow the allowed list with `availableTools`. It cannot add a
blocked tool: `resolveCopilotToolSelection` rejects any built-in that is not in
the manifest.

## Allowed tools (on by default)

Copilot gives each model one of two tool sets (catalogs). On CLI 1.0.95 every
GPT model gets the `codex` set and other models get the `default` set.
floe-runtime reads the set from the session, not from the model name.

On Linux the shell tools are `bash`, `read_bash`, `stop_bash` and `list_bash`
instead of the PowerShell names.

| Tool | Catalog | Floe operation | What it does |
|---|---|---|---|
| `powershell` | both | `engine.tool.process.execute` | Runs a shell command. |
| `read_powershell` | both | `engine.tool.process.execute` | Reads output from a running shell command. |
| `stop_powershell` | both | `engine.tool.process.execute` | Stops a running shell command and its child processes. |
| `list_powershell` | both | `engine.tool.process.execute` | Lists active shell sessions. |
| `view` | both | `engine.tool.filesystem.read` | Reads a file, image or folder listing. |
| `glob` | both | `engine.tool.filesystem.read` | Finds files by name pattern. |
| `grep` | default | `engine.tool.filesystem.read` | Searches file contents (ripgrep). |
| `rg` | codex | `engine.tool.filesystem.read` | Searches file contents (ripgrep). |
| `create` | default | `engine.tool.filesystem.write` | Creates a new file. |
| `edit` | default | `engine.tool.filesystem.write` | Replaces text in a file. |
| `apply_patch` | codex | `engine.tool.filesystem.write` | Adds, edits, moves or deletes files with one patch. |
| `web_fetch` | both | `engine.tool.network.fetch` | Fetches a web page as Markdown or HTML. |

## Blocked Copilot tools

These are Copilot's own tools. They are removed from every session and can't
be turned back on.

| Tool | What it does | Why it is blocked |
|---|---|---|
| `task` | Starts a Copilot sub-agent in its own context. | Work is delegated through the host app, not a hidden vendor agent fleet. |
| `read_agent` | Reads a Copilot sub-agent's status and results. | Part of the vendor sub-agent system. |
| `list_agents` | Lists Copilot sub-agents. | Part of the vendor sub-agent system. |
| `write_agent` | Sends a message to a running Copilot sub-agent. | Part of the vendor sub-agent system. |
| `run_dynamic_workflow` | Starts or resumes a Copilot workflow that can spawn many sub-agents. | Vendor orchestration; can spawn agents and spend credits outside the host's control. |
| `dynamic_workflows_manage` | Creates, inspects and lists Copilot workflows. | Vendor orchestration. |
| `skill` | Loads a Copilot skill into the conversation. | Copilot skills are switched off (see below). The host supplies instructions instead. |
| `sql` | Queries a per-session SQLite database (todos and scratch tables). | Vendor-held state that the host can't see. |
| `session_store_sql` | Queries the history of past Copilot sessions. | Reads vendor session history that may include other users' or apps' work. |
| `ask_user` | Asks the person at the terminal a question and waits. | Assumes a person at a Copilot terminal. The host owns all questions and replies. |
| `manage_schedule` | Schedules prompts to run later or repeatedly. | Runs work outside the host's control and timing. |

Other tool sources are blocked too: tools from MCP servers (including the
GitHub MCP server), memory tools, and tools that only appear in Copilot's
interactive terminal.

## Copilot features switched off

`CopilotRuntime` sets these on every session. An app cannot change them yet.

| Setting | Effect |
|---|---|
| `enableConfigDiscovery: false` | Ignores Copilot config files in the project and user folders. |
| `skipCustomInstructions: true` | Ignores repository instruction files such as `AGENTS.md` and `.github/copilot-instructions.md`. |
| `instructionDirectories: []`, `enableOnDemandInstructionDiscovery: false` | Loads no extra instruction folders and doesn't look for instructions during a turn. |
| `enableSkills: false`, `includedBuiltinSkills: []`, `skillDirectories: []` | No Copilot skills. |
| `customAgents: []`, `customAgentsLocalOnly: true` | No Copilot custom agents. |
| `pluginDirectories: []` | No Copilot plugins. |
| `mcpServers: {}` | No MCP servers. |
| `enableFileHooks: false` | Ignores hook scripts defined in project files. |
| `memory: { enabled: false }` | No Copilot memory across sessions. |
| `enableSessionStore: false` | Doesn't write sessions to Copilot's searchable history. |
| `manageScheduleEnabled: false` | No scheduled prompts. |
| `toolSearch: { enabled: false }` | Doesn't load tools on demand. |
| `enableHostGitOperations: false` | Copilot runs no git operations of its own. |
| `coauthorEnabled: false` | No Copilot co-author trailer on commits. |
| `enableExperimentalMode: false` | No experimental Copilot features. |
| `enableSessionTelemetry: false` | No session telemetry. |
| `skipEmbeddingRetrieval: true`, `embeddingCacheStorage: 'in-memory'` | No embedding-based code retrieval; nothing cached on disk. |
| `mcpOAuthTokenStorage: 'in-memory'` | Never stores MCP sign-in tokens on disk. |
| `requestExtensions: false` | Loads no Copilot extensions. |

Copilot permission prompts are not used either. Every session is put in manual
permission mode with no auto-approvals, and Floe's pre-tool check makes the
decisions.

## System message

The default system message also removes Copilot's CLI-product instructions.
Unlike tools, every part of it can be changed or restored by the app or actor
layer. See "System message layers" in the README.

## Codex backend

`CodexRuntime` doesn't remove Codex tools. Codex runs its own tools inside its
sandbox. floe-runtime starts each thread read-only with approval on request, and
`setPermissions()` changes the sandbox level.
