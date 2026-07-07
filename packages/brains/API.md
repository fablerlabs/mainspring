# @mainspring/brains API

Reference implementations of the `Brain` contract (mirrored from
`@mainspring/core`): a scripted `MockBrain` for tests and examples, and a
`ClaudeBrain` adapter for Anthropic's Messages API. Zero runtime
dependencies — `ClaudeBrain` talks to Anthropic with plain `fetch`, no
`@anthropic-ai/sdk` dependency, and never reads secrets from the
environment (the API key is a required constructor argument only).

## Exports

### `src/mock.ts`

#### `class MockBrain implements Brain`

A scripted, deterministic `Brain` for tests and examples. Constructed with
an ordered array of `StepResult`s, it returns one per `step()` call and
records every `SessionInput` (and accompanying history) it was handed, so a
test can assert on exactly what the loop assembled and gave the brain.

```ts
constructor(script: StepResult[])
```

- `script` — the ordered `StepResult`s to hand back, one per call to `step()`.

Properties:

- `readonly id = "mock"`
- `readonly model = "mock-scripted"`
- `readonly received: Array<{ input: SessionInput; history: Turn[] }>` — every `(input, history)` pair passed to `step()`, in call order.

Methods:

```ts
async step(input: SessionInput, history: Turn[]): Promise<StepResult>
```

Pushes `{ input, history }` onto `received`, then returns the next scripted
`StepResult` in order. Throws `Error("MockBrain: step() was called N times
but only M scripted StepResult(s) were provided")` once the script is
exhausted (verified by test: `MockBrain throws once the script is
exhausted`).

`MockBrain` has no `estimateCost` (the `Brain` interface only requires it
optionally).

Usage (from `README.md` / `test/brains.test.ts`):

```ts
import { MockBrain } from "@mainspring/brains";

const brain = new MockBrain([
  { actions: [{ kind: "done" }], usage: { inputTokens: 0, outputTokens: 0, wallMs: 0 }, done: true },
]);

const result = await brain.step(sessionInput, []);
// brain.received[0] === { input: sessionInput, history: [] }
```

### `src/claude.ts`

#### Constants

```ts
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-x";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const PROPOSE_ACTIONS_TOOL = "propose_actions";
```

- `DEFAULT_CLAUDE_MODEL` — placeholder model id used when `ClaudeBrainConfig.model` is not set. The source comment is explicit that this is a placeholder: real Anthropic model ids change over time, so production config should always set `model` explicitly.
- `ANTHROPIC_MESSAGES_URL` — the Anthropic Messages API endpoint `buildClaudeRequest` targets by default.
- `ANTHROPIC_VERSION` — the default `anthropic-version` header value.
- `PROPOSE_ACTIONS_TOOL` — `"propose_actions"`, the one tool name every `ClaudeBrain` request registers alongside the caller's own `ToolSpec`s. It is the only way the model can propose `Action`s and signal `done` for a step; every other `tool_use` block the model emits is translated into a `run` Action instead (see `parseClaudeResponse` below).

#### `interface ClaudeBrainConfig`

```ts
interface ClaudeBrainConfig {
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  apiUrl?: string;
  anthropicVersion?: string;
}
```

- `apiKey` — Anthropic API key. Required, and only ever read from this field — `ClaudeBrain` never touches `process.env` (this is a deliberate Mainspring rule: secrets are injected by the caller, not discovered by the brain).
- `model` — Anthropic model id. Defaults to `DEFAULT_CLAUDE_MODEL` when unset.
- `systemPrompt` — system prompt describing the brain's role. When unset, the request body omits the `system` field entirely (rather than sending an empty string).
- `maxTokens` — defaults to `4096` (internal `DEFAULT_MAX_TOKENS`, not exported) when unset.
- `apiUrl` — override the Messages endpoint; documented in source as for tests/API proxies only. Defaults to `ANTHROPIC_MESSAGES_URL`.
- `anthropicVersion` — override the `anthropic-version` header. Defaults to `ANTHROPIC_VERSION`.

#### `interface AnthropicToolSpec`

```ts
interface AnthropicToolSpec {
  name: string;
  description?: string;
  input_schema: unknown;
}
```

Anthropic-shaped tool declaration. `buildClaudeRequest` produces one of
these for `PROPOSE_ACTIONS_TOOL` plus one per `ToolSpec` in
`SessionInput.tools` (via the internal `toolSpecToAnthropicTool`, which maps
`ToolSpec.argsSchema` to `input_schema`, defaulting to `{ type: "object" }`
when `argsSchema` is unset).

#### `interface AnthropicMessage`

```ts
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}
```

One request message. `buildClaudeRequest` maps each `Turn` to one of these:
`Turn.role === "brain"` becomes `"assistant"`, anything else (`"loop"`)
becomes `"user"`.

#### `interface AnthropicMessagesRequestBody`

```ts
interface AnthropicMessagesRequestBody {
  model: string;
  system?: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  tools: AnthropicToolSpec[];
}
```

The JSON body `buildClaudeRequest` produces and `ClaudeBrain.step` sends as
the POST body (via `JSON.stringify`).

#### `interface AnthropicRequest`

```ts
interface AnthropicRequest {
  url: string;
  headers: Record<string, string>;
  body: AnthropicMessagesRequestBody;
}
```

The full, transport-agnostic request shape returned by `buildClaudeRequest`:
target URL, headers, and body. `ClaudeBrain.step` destructures this directly
into its `fetch` call.

#### `interface AnthropicContentBlock`

```ts
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
```

One block of an Anthropic Messages API response's `content` array. Only
`type === "tool_use"` blocks (with a `name`) are interpreted by
`parseClaudeResponse`; other block types (e.g. `"text"`) are ignored.

#### `interface AnthropicMessagesResponse`

```ts
interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}
```

The shape `parseClaudeResponse` expects as input and `ClaudeBrain.step`
casts the fetched JSON body to (`as AnthropicMessagesResponse` — no runtime
schema validation is performed on the network response; a response that
doesn't actually match this shape will only fail if/when
`parseClaudeResponse` dereferences a missing field, per its defaulting
logic described below). `stop_reason` is part of the type but is not read
anywhere in `parseClaudeResponse`.

#### `function buildClaudeRequest`

```ts
function buildClaudeRequest(
  input: SessionInput,
  history: Turn[],
  config: ClaudeBrainConfig,
): AnthropicRequest
```

Pure request builder: `SessionInput` + prior `Turn[]` + `ClaudeBrainConfig`
in, an `AnthropicRequest` out. No network access — safe to unit test
directly (and is: see `test/brains.test.ts`).

Behavior:

- Converts `history` into `AnthropicMessage[]` (`"brain"` -> `"assistant"`, else `"user"`), then appends one more `"user"` message whose content is `renderSessionInput(input)` — a plain-text rendering of the constitution, `STATE.md`, journal tail, ledger tail, inbox, health, pending relay, queue, and budget, ending with an instruction to call `propose_actions`.
- Builds the `tools` array as `[actionsToolSpec(), ...input.tools.map(toolSpecToAnthropicTool)]` — i.e. `propose_actions` is always present, in addition to every tool in `input.tools`.
- `url` is `config.apiUrl ?? ANTHROPIC_MESSAGES_URL`.
- `headers` always include `content-type: application/json`, `x-api-key: config.apiKey`, and `anthropic-version: config.anthropicVersion ?? ANTHROPIC_VERSION`.
- `body.model` is `config.model ?? DEFAULT_CLAUDE_MODEL`; `body.system` is included only if `config.systemPrompt` is truthy (otherwise the key is absent from the object, not set to `undefined`); `body.max_tokens` is `config.maxTokens ?? 4096`.

Test-verified behaviors (`test/brains.test.ts`): endpoint/header values and
defaults; `model` default and override; `system` present when configured
and absent (`"system" in body === false`) when not; history-to-messages
mapping including role translation; `propose_actions` plus registry tools
present in `body.tools` with no duplicates.

```ts
import { buildClaudeRequest, ANTHROPIC_MESSAGES_URL } from "@mainspring/brains";

const { url, headers, body } = buildClaudeRequest(sessionInput, [], {
  apiKey: process.env.ANTHROPIC_API_KEY!,
  systemPrompt: "You are the brain of a solo agent business.",
});
// url === ANTHROPIC_MESSAGES_URL
// headers["x-api-key"] === the configured apiKey
```

#### `function parseClaudeResponse`

```ts
function parseClaudeResponse(
  response: AnthropicMessagesResponse,
  wallMs: number,
): StepResult
```

Pure response parser: an `AnthropicMessagesResponse` + elapsed wall-clock
milliseconds in, a `StepResult` out. No network access — safe to unit test
directly with a fixture response.

Behavior, iterating `response.content ?? []`:

- Any block where `block.type !== "tool_use"` or `block.name` is falsy is skipped entirely (this is how plain `"text"` blocks are ignored).
- If `block.name === PROPOSE_ACTIONS_TOOL`: `block.input` is cast (`as { actions?: Action[]; done?: boolean } | undefined`, no runtime validation) and, if `proposed.actions` is present, those `Action`s are appended to the result's `actions`; if `proposed.done` is truthy, the result's `done` becomes `true`. There is no guard against multiple `propose_actions` blocks in one response — actions from each would all be appended, and `done` would be `true` if any one of them sets it.
- For any other named tool_use block, one `{ kind: "run", tool: block.name, args: block.input }` Action is appended — i.e. any tool call the model makes other than `propose_actions` is treated as a `run` Action for the caller's own tool registry, with no validation that `block.input` matches the tool's schema.
- `usage.inputTokens`/`outputTokens` default to `0` when `response.usage` (or its fields) is absent; `usage.wallMs` is always the passed-in `wallMs` verbatim.
- `done` defaults to `false` unless a `propose_actions` block explicitly sets it.
- There is no throw/error path in `parseClaudeResponse` itself — a missing `tool_use` block, an empty `content` array, or a completely absent `propose_actions` call all resolve quietly to `{ actions: [], usage: {...}, done: false }` rather than raising an error. This is confirmed by the test `parseClaudeResponse ignores text blocks and defaults usage/done when absent`.

```ts
import { parseClaudeResponse, PROPOSE_ACTIONS_TOOL } from "@mainspring/brains";

const result = parseClaudeResponse(
  {
    content: [
      {
        type: "tool_use",
        name: PROPOSE_ACTIONS_TOOL,
        input: { actions: [{ kind: "notify", to: "owner", text: "shipped a thing" }], done: true },
      },
    ],
    usage: { input_tokens: 120, output_tokens: 40 },
  },
  250,
);
// result.done === true
// result.actions === [{ kind: "notify", to: "owner", text: "shipped a thing" }]
// result.usage === { inputTokens: 120, outputTokens: 40, wallMs: 250 }
```

#### `class ClaudeBrain implements Brain`

Reference `Brain` adapter for Anthropic's Messages API.

```ts
constructor(config: ClaudeBrainConfig)
```

Throws `Error("ClaudeBrain: apiKey is required and must be passed
explicitly (never read from process.env)")` if `config.apiKey` is falsy
(test-verified). Otherwise stores `config` and sets `this.model = config.model
?? DEFAULT_CLAUDE_MODEL`.

Properties:

- `readonly id = "claude"`
- `readonly model: string` — the resolved model id (config value or `DEFAULT_CLAUDE_MODEL`).

Methods:

```ts
async step(input: SessionInput, history: Turn[]): Promise<StepResult>
```

1. Builds the request via `buildClaudeRequest(input, history, this.config)`.
2. Records `startedAt = Date.now()`, calls `fetch(url, { method: "POST", headers, body: JSON.stringify(body) })`, and computes `wallMs = Date.now() - startedAt`.
3. If `!res.ok`: attempts `await res.text()` (swallowing any error from that read, via `.catch(() => "")`) and throws `Error("ClaudeBrain: Anthropic API returned {status} {statusText}{: detail, if any}")`. Note the thrown error is **not typed** — a caller must catch a generic `Error`.
4. Otherwise, `await res.json()` is cast (`as AnthropicMessagesResponse`, no runtime validation) and passed to `parseClaudeResponse(data, wallMs)`.
5. If `res.json()` itself throws (e.g. malformed JSON body on a 2xx response), that rejection propagates out of `step()` uncaught — there is no try/catch around it, so callers see the underlying `SyntaxError` from `JSON.parse`, not a `ClaudeBrain`-branded error.

```ts
async estimateCost(usage: Usage): Money
```

Always returns `{ usd: 0 }`, regardless of `usage`. The source comment
explains: pricing varies by model/tier and changes over time, so v1 reports
$0 rather than guess.

**Not test-verified**: the entire live-network path inside `step()` — the
`fetch` call, non-2xx handling (`res.ok` branch, including the
`res.text().catch(...)` fallback), and JSON parsing of a real Anthropic
response — has no test coverage in `test/brains.test.ts`. Only construction
(`apiKey` validation, `id`/`model` defaults) and `estimateCost` are tested
for `ClaudeBrain` itself; `buildClaudeRequest` and `parseClaudeResponse`
are tested in isolation as pure functions, but `step()`'s orchestration of
`fetch` + error branching is exercised only implicitly by combining those
two pure functions — never against a real or mocked HTTP call.

```ts
import { ClaudeBrain } from "@mainspring/brains";
import { runSession } from "@mainspring/core";

const brain = new ClaudeBrain({ apiKey: process.env.ANTHROPIC_API_KEY! });

await runSession({ workspaceDir: "./my-business", constitution, brain });
```

### `src/types.ts`

These types are re-exported from `@mainspring/brains` but are **not** the
source of truth: they are hand-transcribed mirrors of
`@mainspring/core`'s `src/types.ts`, kept so this package stays
zero-dependency and self-hostable (matching `@mainspring/memory`,
`@mainspring/scrub`, and `@mainspring/relay`). Comparing the two files
directly confirms `Action`, `Brain`, `Constitution`, `HealthReport`,
`LedgerEntry`, `Money`, `MoneyCaps`, `OwnerMessage`, `RelayRequest`,
`SessionInput`, `StepResult`, `ToolSpec`, `Turn`, `Usage`, and `WorkOrder`
are structurally identical between the two packages (core additionally
defines `GateDecision`, `DispatchResult`, and `SessionSummary`, which this
package does not mirror or export, since they aren't part of the `Brain`
contract). If core's shapes change, this file must be updated by hand to
match — there is no build-time check enforcing the two stay in sync.

- **`Money`** — `{ usd: number }`. Decimal USD amount, minor-unit-free for v1.
- **`Usage`** — `{ inputTokens: number; outputTokens: number; wallMs: number }`. Token/time accounting for one `Brain.step()` call.
- **`LedgerEntry`** — `{ date: string; type: "revenue" | "expense" | "refund" | "adjustment"; description: string; amountUsd: number }`. One line of the append-only business ledger; `amountUsd` is always positive, sign implied by `type`.
- **`WorkOrder`** — `{ id: string; title: string; body: string; createdAt: string }`. A unit of work the brain wants done later, by itself or a human/lane.
- **`RelayRequest`** — `{ id: string; summary: string; detail: string; estimateMinutes?: number; createdAt: string }`. A blocker only a human can clear.
- **`OwnerMessage`** — `{ id: string; receivedAt: string; text: string; approvalCode?: string }`. A message from the owner, delivered out-of-band.
- **`HealthReport`** — `{ ok: boolean; lastSessionFailed: boolean; notes: string[] }`. Result of the self-maintenance/supervisor health check.
- **`ToolSpec`** — `{ name: string; description: string; argsSchema?: unknown }`. A tool the brain may request via a `run` Action.
- **`Turn`** — `{ role: "brain" | "loop"; content: string; at: string }`. One prior brain <-> loop exchange, for in-session context.
- **`MoneyCaps`** — `{ perSessionUsd: number; notifyAboveUsd: number; approvalAboveUsd: number }`. Money/behavior caps the gate enforces per session.
- **`Constitution`** — `{ name: string; mission: string; hardRules: string[]; moneyCaps: MoneyCaps; maxSessionMs: number }`. The governing document a workspace is booted with.
- **`SessionInput`** — `{ constitution: Constitution; state: string; journalTail: string; ledgerTail: LedgerEntry[]; inbox: OwnerMessage[]; health: HealthReport; pendingRelay: RelayRequest[]; queue: WorkOrder[]; tools: ToolSpec[]; budget: { remainingUSD: number; sessionMs: number } }`. Everything a Brain sees to decide what to do next, assembled fresh each session.
- **`Action`** — discriminated union on `kind`: `"run"` (`{ tool: string; args: unknown }`), `"write"` (`{ path: string; content: string }`), `"ledger"` (`{ entry: LedgerEntry }`), `"enqueue"` (`{ order: WorkOrder }`), `"relay"` (`{ request: RelayRequest }`), `"notify"` (`{ to: "owner"; text: string; priority?: "high" }`), `"done"` (no extra fields). The only vocabulary a Brain can act in; every kind is validated by the gate.
- **`StepResult`** — `{ actions: Action[]; usage: Usage; done: boolean }`. What a Brain returns from one reasoning step.
- **`Brain`** — `{ readonly id: string; readonly model: string; step(input: SessionInput, history: Turn[]): Promise<StepResult>; estimateCost?(usage: Usage): Money }`. The interface `MockBrain` and `ClaudeBrain` both implement.

```ts
import type { Brain, SessionInput, StepResult } from "@mainspring/brains";

class MyBrain implements Brain {
  readonly id = "my-brain";
  readonly model = "v1";
  async step(input: SessionInput, history: []): Promise<StepResult> {
    return { actions: [{ kind: "done" }], usage: { inputTokens: 0, outputTokens: 0, wallMs: 0 }, done: true };
  }
}
```
