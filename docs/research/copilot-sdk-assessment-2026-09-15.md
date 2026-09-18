# GitHub Copilot SDK assessment

**Date:** 2026-09-15

## Recommendation

Treat the official Copilot SDK as the intended replacement for Floe's Copilot
ACP integration, not as a permanent second runtime for operators to choose.
Keep ACP only as a temporary rollback path until cancellation, incomplete-output,
resume, and packaging tests pass on every supported platform.

The SDK is the better supported integration boundary. It supplies a compatible
runtime with the Node package, accepts a real system message, exposes direct
host-owned tools, supports documented authentication and BYOK options, streams
typed events, and lists and selects models through first-class APIs.

The remaining risk is lifecycle interpretation. ACP returns an explicit
prompt-level stop reason. The SDK ends an interaction with `session.idle`, while
`assistant.turn_end` describes one model call inside the larger agent loop.
Floe must build its own fail-closed result classification around the SDK events
rather than treating `sendAndWait()` as the whole runtime contract.

## What the SDK is

The official repository is
[`github/copilot-sdk`](https://github.com/github/copilot-sdk). GitHub describes
it as the supported way to embed the same agent engine used by Copilot CLI in
applications. It is generally available and follows semantic versioning.

As checked on 2026-09-15:

- The stable Node package is
  [`@github/copilot-sdk@1.0.13`](https://registry.npmjs.org/%40github%2Fcopilot-sdk/1.0.13).
- It requires Node.js `^20.19.0 || >=22.12.0`.
- Its source and SDK package are MIT licensed:
  [`LICENSE`](https://github.com/github/copilot-sdk/blob/a675b55531a9dfc647ee015e32d74279568550f3/LICENSE).
- The same official repository publishes SDKs for TypeScript/Node.js, Python,
  Go, .NET, Java, and Rust:
  [`README`](https://github.com/github/copilot-sdk/blob/a675b55531a9dfc647ee015e32d74279568550f3/README.md#L14-L27).
- The Node package pins Copilot runtime version `1.0.83` and installs a matching
  platform package.

The SDK is not a new model engine. It is a typed JSON-RPC client and process
manager around the Copilot runtime. GitHub's own architecture description is:
application -> SDK client -> Copilot CLI/runtime.

## Does it remove the separate CLI install?

**Yes for Floe's Node runtime, but it does not remove the subprocess.**

The Node package installs a platform-specific dependency such as
`@github/copilot-sdk-win32-x64`, materializes the runtime, starts it as a child
process, and communicates over stdio. A separately installed `copilot` command
is not required. `COPILOT_CLI_PATH` remains available as an override.

Primary sources:

- [Node SDK runtime packaging](https://github.com/github/copilot-sdk/blob/f13e4a2cc7e4e220974d2333142234e162a3252e/nodejs/README.md#L5-L18)
- [Bundled-runtime guide](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/bundled-cli)
- [Runtime resolution source](https://github.com/github/copilot-sdk/blob/a675b55531a9dfc647ee015e32d74279568550f3/nodejs/src/runtimeArtifacts.ts#L144-L178)
- [Child-process startup source](https://github.com/github/copilot-sdk/blob/f13e4a2cc7e4e220974d2333142234e162a3252e/nodejs/src/client.ts#L2660-L2698)

### Live verification

The published Windows packages were installed in a temporary directory:

- `@github/copilot-sdk-win32-x64@1.0.13` is about 115 MB unpacked.
- It includes `copilot-runtime.exe` (about 580 KB), `runtime.node` (about
  83 MB), authentication libraries, schemas, and bundled runtime assets.
- It does not install a normal `copilot.exe` command on `PATH`.
- With `PATH` reduced to Node's directory and `COPILOT_CLI_PATH` unset,
  `CopilotClient.start()`, `ping()`, and `listModels()` succeeded.

This proves that Floe would lose the external installation prerequisite, while
retaining a vendor-managed child-process boundary.

## Authentication

The claim that the SDK "handles authentication itself" is only partly true.
The SDK and bundled runtime handle credential selection and use. They do not
remove the need for a supported human or application authentication flow.

### Default signed-in-user path

The documented one-time flow is:

1. The human runs `copilot` and signs in through GitHub OAuth.
2. The vendor runtime stores credentials in the operating system keychain.
3. Later SDK sessions reuse those credentials without Floe reading them.

GitHub documents macOS Keychain, Windows Credential Manager, and Linux
libsecret. A plaintext `~/.copilot/config.json` fallback requires explicit user
consent. See
[Authenticating with GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).

The SDK's documented credential order is:

1. explicit SDK `gitHubToken`;
2. direct Copilot API environment credentials;
3. `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`;
4. stored Copilot CLI OAuth credentials;
5. GitHub CLI credentials.

See the official
[SDK authentication guide](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate).

Live verification showed that the bundled runtime reported an authenticated
user and listed models even when no `copilot` executable was available on
`PATH`. No credential value or user identity was read.

### Practical consequence for Floe

- Reusing vendor-owned keychain credentials preserves ADR-0013.
- It remains machine-local: another machine needs its own login.
- A polished first-run experience still needs a supported login path. The
  high-level SDK docs tell the user to sign in through Copilot CLI, or tell the
  application to run GitHub OAuth and pass the resulting token.
- If Floe runs OAuth or supplies a token, Floe is handling model
  authentication. That is vendor-supported, but it changes ADR-0013 and the
  security boundary. It must be an explicit product decision, not a hidden
  implementation detail.
- Shared or server deployments should use per-session tokens and the SDK's
  documented `mode: "empty"` isolation rather than one ambient personal login.

## Bring your own key

**Yes. BYOK is documented and first class. It bypasses GitHub authentication
and does not require a Copilot subscription.**

Supported provider types are:

| SDK type | Supported target |
| --- | --- |
| `openai` | OpenAI, Microsoft Foundry's OpenAI-compatible endpoint, Ollama, Foundry Local, vLLM, LiteLLM, and other OpenAI-compatible services |
| `azure` | Native Azure OpenAI endpoints |
| `anthropic` | Anthropic's Messages API |

The session requires an explicit model. Static API keys, static bearer tokens,
and token-provider callbacks are available. The singular per-session provider
configuration is stable; additive multi-provider configuration and
`bearerTokenProvider` are marked experimental in the Node types.

Primary source:
[official BYOK guide](https://github.com/github/copilot-sdk/blob/a675b55531a9dfc647ee015e32d74279568550f3/docs/auth/byok.md).

BYOK is technically suitable for Floe, but it is not free architecturally.
Passing an API key or bearer token into `createSession()` means Floe receives
and injects a model credential. That conflicts with the current literal
ADR-0013 rule even though it uses a vendor-supported API. BYOK therefore
requires a deliberate ADR revision and secret-broker design. It should not be
smuggled into the transport migration.

BYOK also changes the product surface:

- usage and rate limits belong to the chosen provider;
- GitHub premium-request accounting does not apply;
- some GitHub-backed features are unavailable without GitHub authentication,
  including GitHub MCP, code search, and delegation;
- custom model discovery may require Floe to supply `onListModels()`.

## Capability comparison

| Floe requirement | SDK result | Assessment |
| --- | --- | --- |
| Actor-turn boundary | `session.idle` is documented as fully idle, with no background agents or attached shell commands. `sendAndWait()` waits for it. | **Equivalent boundary, weaker outcome detail.** Do not confuse `assistant.turn_end` with a Floe turn; one user interaction may contain several model turns. |
| Streaming | Typed message, reasoning, tool output, progress, and final events. | **Better.** Live test emitted message deltas and final events. |
| Cancellation | `abort()` acknowledges the cancel request; `session.idle.data.aborted` confirms the later terminal boundary. | **Usable but requires adapter logic.** `abort()` alone is not quiescence. |
| Tool calls | Direct `defineTool()` host callbacks plus typed start, partial-result, progress, and completion events; MCP remains available. | **Better.** Floe can remove the loopback HTTP MCP shim and keep authority inside the Bridge. |
| Model list and selection | `listModels()`, creation-time `model`, and `setModel()` are first-class. | **Better.** No ACP probe session or ignored creation parameter workaround. |
| System prompt | `systemMessage` supports append, customize, or replace. | **Better.** No first-turn prompt folding. |

Primary sources:

- [Agent loop and completion signals](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/agent-loop)
- [Streaming and tool event contract](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Node API reference](https://github.com/github/copilot-sdk/blob/f13e4a2cc7e4e220974d2333142234e162a3252e/nodejs/README.md)

### Turn-end risk

ACP's prompt response has a finite stop-reason set: `end_turn`, `max_tokens`,
`max_turn_requests`, `refusal`, and `cancelled`. Floe currently uses that to
reject incomplete structured output.

The SDK's `assistant.turn_end` does not carry an equivalent prompt-level stop
reason. `assistant.usage.finishReason` is optional and describes an individual
model call, not the complete agent interaction. `sendAndWait()` returns the last
assistant message or `undefined` after `session.idle`; it throws on
`session.error`, but cancellation need not produce that event.

An SDK adapter must therefore:

1. subscribe before sending;
2. track final assistant messages, usage finish reasons, `session.error`,
   `abort`, and `session.idle`;
3. accept completion only at `session.idle`;
4. classify `session.idle.data.aborted` as cancellation;
5. fail closed when the final message is absent or completeness is uncertain.

### Cancellation risk

The SDK documents `abort()` as resolving when the abort request is acknowledged,
not when work has stopped. Floe must call `abort()` and then await
`session.idle`, with a bounded timeout that reports quiescence as unknown if the
idle event never arrives.

A live Windows test confirmed this ordering:

1. `abort()` acknowledged in about 13 ms.
2. The runtime then emitted `abort`, `model.turn_failed`,
   `assistant.turn_end`, and `session.idle`.
3. No `session.error` was emitted.

The live path is viable, but a migration must test cancellation while a shell
command, direct Floe tool, MCP tool, and sub-agent are active. The current
release added cancellation signals for host-owned tool handlers, but propagation
timing still needs Floe-specific proof.

### Direct tool verification

A live `gpt-5-mini` session registered one allow-listed in-process
`defineTool()` handler. The model called it once. The SDK emitted
`tool.execution_start`, `tool.execution_complete { success: true }`, and then
`session.idle`; the final response used the handler result.

This can replace Floe's HTTP MCP bridge for substrate operations:

- no loopback listener or per-session HTTP token;
- no dependency on the CLI's broken ACP stdio-MCP behavior;
- Bridge-owned authorization remains inside the tool handler;
- typed tool lifecycle events replace ACP update normalization.

`skipPermission` is appropriate only where the Bridge handler performs the
complete operation-authority check.

## Model-list observation

The live SDK returned 20 models for the current authenticated account, including
`gpt-5-mini`. Current metadata reports token prices rather than the earlier
zero-times multiplier. The official current pricing page lists GPT-5 mini at
$0.25 input and $2.00 output per million tokens:
[models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).

The model count, availability, policy, and price representation are live
account/runtime data. Floe must not hard-code the earlier count of 25 or assume
that `gpt-5-mini` remains zero-cost.

## License and terms

There are two layers:

1. The SDK source and package are MIT licensed.
2. The bundled Copilot runtime is proprietary and GitHub service use remains
   subject to the account's GitHub or Microsoft terms.

The runtime license permits redistribution only when it is unmodified, included
inside an application or service with material additional functionality, not
distributed as the primary or standalone product, and shipped with required
license notices:
[Copilot CLI license](https://github.com/github/copilot-cli/blob/b49df25cafe802d2012876c8703332064237c7e3/LICENSE.md#L3-L36).

Floe fits the documented application-embedding shape. The official SDK docs
explicitly describe desktop apps, standalone tools, services, OAuth apps, and
bundled distribution. No primary source reviewed forbids Floe's proposed use.

Required boundaries:

- do not modify or redistribute the proprietary runtime by itself;
- retain its license and notices in packaged Floe builds;
- use documented OAuth, environment-token, server-to-server, stored-login, or
  BYOK paths;
- do not read or copy local keychain credentials;
- do not call private Copilot endpoints or impersonate another client;
- do not share a personal login across users or use tokens to evade limits;
- apply the organization's actual GitHub or Microsoft agreement and the
  relevant third-party provider terms for BYOK.

GitHub's current public terms chain is:

- [Additional Product Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)
- [GitHub Generative AI Services Terms](https://github.com/customer-terms/github-generative-ai-services-terms)
- [GitHub Terms of Service, AI Features](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#j-ai-features-training-and-your-data)

The Additional Product Terms still link Business and Enterprise customers to a
Copilot-specific page that says it was superseded on 2026-03-05. The
organization's contract owner should confirm the governing enterprise or
Microsoft agreement before distribution. This is a contract-link ambiguity,
not evidence that SDK embedding is prohibited.

## Cost and migration gates

This is a medium transport change and a high-assurance lifecycle change. It is
not a model or agent rewrite.

Work required:

1. Add an SDK-backed Copilot adapter while preserving Floe's existing runtime
   interface and event vocabulary.
2. Map one Floe actor turn to `send()` through terminal `session.idle`, not to
   individual `assistant.turn_end` events.
3. Implement abort-plus-idle quiescence and conservative result
   classification.
4. Replace the HTTP MCP substrate bridge with direct host tools while keeping
   Bridge operation-authority checks.
5. Move system instructions to `systemMessage` append/customize mode.
6. Map model listing, creation-time selection, usage, persistence, and resume.
7. Package the roughly 115 MB platform runtime and preserve notices.
8. Run live tests for normal completion, truncation, refusal, content filter,
   process loss, resume, active-tool cancellation, background agents, identity
   isolation, and each supported operating system.

Do not combine BYOK onboarding with this transport change. First replace ACP
while preserving vendor-owned ambient authentication. Decide and design BYOK
credential ownership separately.

## Replacement decision

The durable product shape should remain one Copilot runtime, not two choices
that expose transport details to operators.

Use a temporary internal selector during migration:

- `copilot-acp`: rollback implementation;
- `copilot-sdk`: candidate implementation.

Remove the selector and ACP path after the lifecycle and packaging gates pass.
Keeping both permanently would duplicate authentication behavior, session
semantics, tools, tests, and support work without offering a distinct model
provider or user capability.
