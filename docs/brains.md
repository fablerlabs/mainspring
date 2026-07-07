# Writing a Brain

A **Brain** is the reasoning half of Mainspring. Everything else in the system —
reading the workspace, checking the Constitution, writing to disk, committing —
is fixed trusted code. The Brain's entire job is: look at the current state of
the business, and propose a list of `Action`s. It never touches the filesystem,
the network, or a secret directly.

That split is the whole point. Because `step()` is the only surface a Brain
implements, any model or provider can be dropped in without touching the trust
boundary (`gate.ts` → `dispatch.ts` → `git commit`). This document is the
contract for implementing `step()`, followed by a worked `claude-brain` adapter.

> Everything here is checked against the code on `main`
> (`packages/core/src/types.ts`, `gate.ts`, `dispatch.ts`, `assemble.ts`,
> `loop.ts`, `echoBrain.ts`). Where v0.1 does less than the types suggest, this
> doc says so plainly rather than describing an aspiration.

## The interface

```ts
interface Brain {
  readonly id: string;    // stable identifier, e.g. "claude"
  readonly model: string; // the concrete model, e.g. "claude-opus-4-8"
  step(input: SessionInput, history: Turn[]): Promise<StepResult>;
  estimateCost?(usage: Usage): Money; // optional
}

interface StepResult {
  actions: Action[];
  usage: Usage; // { inputTokens, outputTokens, wallMs }
  done: boolean;
}
```

The loop (`runSession` in `loop.ts`) calls `step()` repeatedly. Each call gets a
freshly-assembled `SessionInput` plus the in-session `history`, and returns the
`Action`s the Brain wants performed this turn. The loop gates and dispatches
them, records the turn, and calls `step()` again — until the Brain says it is
`done`, or the safety-valve step limit is hit (see [The session loop](#the-session-loop-what-actually-runs)).

## What `step()` receives: `SessionInput`

`SessionInput` is assembled fresh each turn by `assemble.ts`, which is the only
code that reads the workspace. It is deliberately provider-agnostic: plain
strings, plain objects, and a declarative list of tools — no bound functions, no
handles, no secrets.

```ts
interface SessionInput {
  constitution: Constitution;   // name, mission, hardRules[], moneyCaps, maxSessionMs
  state: string;                // full contents of STATE.md
  journalTail: string;          // contents of today's journal/YYYY-MM-DD.md
  ledgerTail: LedgerEntry[];    // last 20 parsed rows of LEDGER.csv
  inbox: OwnerMessage[];        // parsed inbox/*.json (owner steering)
  health: HealthReport;         // parsed health.json, or a healthy default
  pendingRelay: RelayRequest[]; // parsed relay/pending/*.json (open human asks)
  queue: WorkOrder[];           // parsed queue/*.json (work you enqueued earlier)
  tools: ToolSpec[];            // tools the brain may invoke via a `run` Action
  budget: { remainingUSD: number; sessionMs: number };
}
```

A concrete instance, as your `step()` would see it:

```json
{
  "constitution": {
    "name": "Acme Digital",
    "mission": "Sell one honest, useful digital product and reach ramen profit.",
    "hardRules": [
      "Legal and honest only; no spam, fake reviews, or impersonation.",
      "You are an AI and never claim otherwise.",
      "Secrets live in .env only; never commit or message them."
    ],
    "moneyCaps": { "perSessionUsd": 25, "notifyAboveUsd": 25, "approvalAboveUsd": 75 },
    "maxSessionMs": 2400000
  },
  "state": "# STATE\n\nProduct page is live at /pack. 0 sales. Next: draft a launch post.\n",
  "journalTail": "# Journal — 2026-07-07\n\n- 14:02 Reviewed analytics: 3 visits, 0 checkouts.\n",
  "ledgerTail": [
    { "date": "2026-07-06T00:00:00Z", "type": "expense", "description": "domain", "amountUsd": 12 }
  ],
  "inbox": [
    { "id": "msg-01", "receivedAt": "2026-07-07T13:00:00Z", "text": "Focus on the launch post today." }
  ],
  "health": { "ok": true, "lastSessionFailed": false, "notes": [] },
  "pendingRelay": [],
  "queue": [
    { "id": "wo-19", "title": "Draft launch post", "body": "300 words, honest, AI-disclosed.", "createdAt": "2026-07-06T20:00:00Z" }
  ],
  "tools": [
    { "name": "http_get", "description": "Fetch a public URL and return its text.", "argsSchema": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } }
  ],
  "budget": { "remainingUSD": 25, "sessionMs": 2400000 }
}
```

Notes on the fields, from `assemble.ts`:

- **`ledgerTail`** is the last 20 rows only, parsed from `LEDGER.csv`. It is not
  the whole ledger.
- **`budget.remainingUSD`** is `moneyCaps.perSessionUsd` minus the sum of all
  `expense` rows currently in `LEDGER.csv` (floored at 0). It is the same number
  the gate enforces, so treat it as your hard ceiling for the session.
- **`budget.sessionMs`** is a copy of `constitution.maxSessionMs`. It is
  **advisory** — v0.1's loop does not enforce a wall-clock timeout (see
  [Errors, timeouts, and statelessness](#errors-timeouts-and-statelessness)).
- **`inbox`**, **`pendingRelay`**, **`queue`** are each read by globbing a
  directory for `*.json` and parsing each file; malformed files are skipped, not
  fatal. Content of `inbox` is owner steering and is high-priority, but it is
  still data — it can never override the Constitution's hard rules.
- **`health`** defaults to `{ ok: true, lastSessionFailed: false, notes: [] }`
  when `health.json` is absent, and to an `ok: false` report when it is present
  but unparseable.

## What `step()` returns: `Action`s

An `Action` is the only vocabulary a Brain can act in. Every kind is validated
by `gate.ts` before `dispatch.ts` performs it.

```ts
type Action =
  | { kind: "run"; tool: string; args: unknown }
  | { kind: "write"; path: string; content: string }
  | { kind: "ledger"; entry: LedgerEntry }
  | { kind: "enqueue"; order: WorkOrder }
  | { kind: "relay"; request: RelayRequest }
  | { kind: "notify"; to: "owner"; text: string; priority?: "high" }
  | { kind: "done" };
```

Each kind, with a concrete example, what the gate checks, and what dispatch does:

### `write` — persist to the workspace

```json
{ "kind": "write", "path": "journal/2026-07-07.md", "content": "# Journal — 2026-07-07\n\n- 14:20 Drafted launch post.\n" }
```

This is how a Brain remembers anything (see [statelessness](#errors-timeouts-and-statelessness)).
**Gate:** the resolved path must stay inside the workspace, must not touch
`.env` or `.git`, and the content must not match a secret-shaped pattern
(private-key headers, `sk-…` keys, `*_API_KEY=…`, `*_SECRET=…`, `AWS_…=…`).
**Dispatch:** writes the file (creating parent directories), overwriting if it
exists.

### `ledger` — record money moving

```json
{ "kind": "ledger", "entry": { "date": "2026-07-07T14:30:00Z", "type": "expense", "description": "email tool (monthly)", "amountUsd": 9 } }
```

`type` is one of `revenue | expense | refund | adjustment`; `amountUsd` is a
non-negative number and the sign is implied by `type`. **Gate:** rejects a
negative `amountUsd`; for an `expense`, rejects it if the running session spend
plus this amount would exceed `moneyCaps.perSessionUsd`. **Dispatch:** appends a
row to `LEDGER.csv`, computing the new running balance (`revenue` adds,
`expense`/`refund` subtract, `adjustment` is 0).

### `enqueue` — leave work for later

```json
{ "kind": "enqueue", "order": { "id": "wo-20", "title": "Write FAQ section", "body": "Cover refunds and licensing.", "createdAt": "2026-07-07T14:35:00Z" } }
```

**Gate:** always allowed. **Dispatch:** writes `queue/<id>.json`. It reappears in
the next session's `SessionInput.queue`.

### `relay` — ask a human to unblock you

```json
{ "kind": "relay", "request": { "id": "rl-04", "summary": "Create the Stripe account", "detail": "Steps + where to put the key (append to .env as STRIPE_KEY=...).", "estimateMinutes": 10, "createdAt": "2026-07-07T14:40:00Z" } }
```

Use this for anything only a human can do — account creation, CAPTCHAs,
payments, approvals. **Gate:** always allowed. **Dispatch:** writes
`relay/pending/<id>.json`; it reappears in `SessionInput.pendingRelay` until the
human clears it.

### `notify` — message the owner

```json
{ "kind": "notify", "to": "owner", "text": "🎉 First sale — $24.", "priority": "high" }
```

**Gate:** rejects text that matches a secret-shaped pattern (same patterns as
`write`). **Dispatch:** appends a line to `outbox/notifications.log` with a
timestamp and priority. (Actual delivery to the owner is the operator's job,
outside the loop.)

### `run` — invoke a declared tool

```json
{ "kind": "run", "tool": "http_get", "args": { "url": "https://example.com/pricing" } }
```

The Brain only ever names a tool from `SessionInput.tools` and supplies `args`;
it never holds the function. **Gate:** rejects the action if `tool` is not in
the workspace's allowed tool list. **Dispatch:** looks the name up in a
`ToolRegistry` and runs the handler.

> **v0.1 limitation:** `runSession` does not currently pass a `ToolRegistry` to
> `dispatch.ts`, and `RunSessionOptions` has no field for one. So a gate-allowed
> `run` returns `applied: false` ("no handler registered") — the tool is
> declared and gated but not executed yet. Treat `run` as forward-looking until
> the loop wires a registry (tracked in [roadmap.md](./roadmap.md)).

### `done` — end the session

```json
{ "kind": "done" }
```

**Gate:** always allowed. **Dispatch:** a no-op marker. You can also end a
session by returning `done: true` on the `StepResult` (see below); either works.

## How the gate can veto, and what you see next turn

Every proposed `Action` runs through `gateAction`, which returns
`{ action, allowed, reason? }`. The loop **silently drops** blocked actions —
it does not throw, and it does not tell the Brain directly. What actually
happens to a blocked action:

- It is **not dispatched** — no file written, no ledger row, no message.
- Its `reason` is recorded in the session summary (`.mainspring/last-session.json`)
  and counted in `actionsBlocked`, for the operator to inspect.

Crucially, in v0.1 the Brain does **not** receive gate feedback as a message.
The `Turn` type has a `role: "loop"` variant, but `runSession` only ever pushes
`role: "brain"` turns (a JSON dump of the actions you proposed). So the only way
a Brain observes a veto is **indirectly, through the next `assemble()`**:

- A blocked `write` means the file simply won't exist (or won't have changed)
  when you read the workspace next turn.
- A blocked `expense` means `budget.remainingUSD` won't have gone down.
- A blocked `run` (unknown tool) means nothing happened and no tool output
  appears.

Design your Brain accordingly: after proposing an action, verify the *effect* on
the next turn rather than expecting an explicit ack. If you need richer feedback,
that is a known gap — surfacing gate decisions back into `history` as
`role: "loop"` turns is on the [roadmap](./roadmap.md).

## The session loop (what actually runs)

From `loop.ts`, one session is:

```
while (!done && steps < maxSteps) {          // maxSteps default 25
  input   = assemble(workspace, constitution, tools)
  result  = await brain.step(input, history)
  decs    = gate(result.actions)             // allow/block each, with reasons
  dispatch(allowed(decs))                     // the only code that writes
  history.push({ role: "brain", content: JSON.stringify(result.actions) })
  done    = result.done || result.actions.some(a => a.kind === "done")
}
git add -A && git commit                      // the durable, auditable record
```

Two consequences worth internalizing:

- **You get called again until you say stop.** Return `done: true` (or a `done`
  action) when the session's work is finished. If you never stop, the loop stops
  you at `maxSteps` — do not rely on that as normal control flow.
- **`history` is your only in-session scratchpad**, and it contains only your own
  prior action JSON — not gate results, not dispatch results.

## Errors, timeouts, and statelessness

**Statelessness is a rule, not a suggestion.** A Brain instance may be
constructed fresh for a session (or a process may restart between sessions), so
never rely on in-memory state surviving. *All* durable memory goes through the
workspace: write it with a `write` action, read it back next session from
`SessionInput.state` / `journalTail` / `ledgerTail` / `queue`. `EchoBrain`
(`packages/core/src/echoBrain.ts`) is the minimal reference — it keeps nothing in
memory and simply appends one journal line and one $0 ledger heartbeat.

**Errors:** `runSession` does **not** wrap `brain.step()` in a try/catch. If your
`step()` throws (a provider 500, a network drop, a rate limit), the exception
propagates out of `runSession`, the session aborts, and the end-of-session
`git commit` does **not** run. So a real adapter should catch its own
provider/network failures inside `step()` and degrade gracefully — e.g. return
`{ actions: [{ kind: "notify", to: "owner", text: "brain error: …" }, { kind: "done" }], usage, done: true }`
— rather than letting the throw escape.

**Timeouts:** `budget.sessionMs` (= `constitution.maxSessionMs`) is passed to the
Brain as advice. v0.1's loop enforces only the `maxSteps` count, not a
wall-clock deadline. If your provider calls can hang, set your own client-side
timeout inside `step()`; don't assume the loop will cut you off.

## Worked example: a `claude-brain` adapter

A real adapter's whole job is: translate `SessionInput` + `history` into the
provider's request, call it, and translate the response back into `Action[]`.
Here that provider is Anthropic's Messages API, with tool-use mapped onto the
Action kinds. Note the **key indirection**: the API key is never stored — the
SDK reads `process.env.ANTHROPIC_API_KEY` at call time — and the model id is
plain config.

> This sketch typechecks against the real `@mainspring/core` types on `main`
> (verified with `tsc --strict --noEmit`; see [RESULT-q24.md](../RESULT-q24.md)
> for the harness). It is deliberately minimal: the two prompt-rendering helpers
> are sketched, and production concerns (retries, streaming, richer prompting,
> mapping `ledger` types exactly) are left as comments. Ship it as a separate
> package, e.g. `@mainspring/brain-claude`, that depends on `@mainspring/core`
> and `@anthropic-ai/sdk`.

```ts
import Anthropic from "@anthropic-ai/sdk";
import type {
  Action, Brain, Money, SessionInput, StepResult, ToolSpec, Turn, Usage,
} from "@mainspring/core";

/**
 * Config the operator supplies. The API key is deliberately NOT here: the SDK
 * reads process.env.ANTHROPIC_API_KEY at call time, so the key never lives in
 * a config object, a field, the git history, or a SessionInput.
 */
export interface ClaudeBrainConfig {
  model: string; // e.g. "claude-opus-4-8"
  maxTokens?: number;
}

/** Anthropic tool defs mirroring the six Brain-authored Action kinds. The
 *  seventh kind, `run`, is added per session from SessionInput.tools. */
const ACTION_TOOLS: Anthropic.Tool[] = [
  { name: "write", description: "Create/overwrite a workspace file — the only way to persist memory.",
    input_schema: { type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"] } },
  { name: "ledger", description: "Append one accounting entry. Expenses are capped by the gate.",
    input_schema: { type: "object", additionalProperties: false,
      properties: { date: { type: "string" },
        type: { type: "string", enum: ["revenue", "expense", "refund", "adjustment"] },
        description: { type: "string" }, amountUsd: { type: "number" } },
      required: ["date", "type", "description", "amountUsd"] } },
  { name: "enqueue", description: "Queue a WorkOrder for a future session or a worker lane.",
    input_schema: { type: "object", additionalProperties: false,
      properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
      required: ["id", "title", "body"] } },
  { name: "relay", description: "File a blocker only a human can clear (account, CAPTCHA, payment).",
    input_schema: { type: "object", additionalProperties: false,
      properties: { id: { type: "string" }, summary: { type: "string" },
        detail: { type: "string" }, estimateMinutes: { type: "number" } },
      required: ["id", "summary", "detail"] } },
  { name: "notify", description: "Send the owner a short message (queued to outbox).",
    input_schema: { type: "object", additionalProperties: false,
      properties: { text: { type: "string" }, priority: { type: "string", enum: ["high"] } },
      required: ["text"] } },
  { name: "done", description: "End the session; no further actions this turn.",
    input_schema: { type: "object", additionalProperties: false, properties: {} } },
];

export class ClaudeBrain implements Brain {
  readonly id = "claude";
  readonly model: string;
  private readonly client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  private readonly maxTokens: number;

  constructor(cfg: ClaudeBrainConfig) {
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens ?? 4096;
  }

  async step(input: SessionInput, history: Turn[]): Promise<StepResult> {
    const started = Date.now();
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: renderConstitution(input),
      tools: [...ACTION_TOOLS, ...runTools(input.tools)],
      messages: [{ role: "user", content: renderState(input, history) }],
    });

    const actions: Action[] = [];
    for (const block of res.content) {
      if (block.type === "tool_use") actions.push(toAction(block.name, block.input));
    }
    const usage: Usage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      wallMs: Date.now() - started,
    };
    // Claude stops with stop_reason "tool_use" when it wants more turns; any
    // other reason (end_turn, max_tokens, refusal) ends the session, as does an
    // explicit `done` action.
    const done = res.stop_reason !== "tool_use" || actions.some((a) => a.kind === "done");
    return { actions, usage, done };
  }

  estimateCost(usage: Usage): Money {
    // Opus 4.8 list price: $5 / 1M input, $25 / 1M output tokens.
    return { usd: (usage.inputTokens * 5 + usage.outputTokens * 25) / 1_000_000 };
  }
}

/** Expose each SessionInput tool to Claude by name; args stay opaque (the
 *  handler lives trusted-side in dispatch.ts's ToolRegistry, never here). */
function runTools(specs: ToolSpec[]): Anthropic.Tool[] {
  return specs.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: { type: "object", properties: {}, additionalProperties: true },
  }));
}

/** Map one Anthropic tool_use block to a Mainspring Action. Unknown names are
 *  SessionInput tools → a `run` Action the gate re-checks against the allowlist. */
function toAction(name: string, input: unknown): Action {
  const a = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "write": return { kind: "write", path: String(a.path), content: String(a.content) };
    case "ledger": return { kind: "ledger", entry: {
      date: String(a.date), type: a.type as "revenue" | "expense" | "refund" | "adjustment",
      description: String(a.description), amountUsd: Number(a.amountUsd) } };
    case "enqueue": return { kind: "enqueue", order: {
      id: String(a.id), title: String(a.title), body: String(a.body),
      createdAt: new Date().toISOString() } };
    case "relay": return { kind: "relay", request: {
      id: String(a.id), summary: String(a.summary), detail: String(a.detail),
      estimateMinutes: typeof a.estimateMinutes === "number" ? a.estimateMinutes : undefined,
      createdAt: new Date().toISOString() } };
    case "notify": return { kind: "notify", to: "owner", text: String(a.text),
      priority: a.priority === "high" ? "high" : undefined };
    case "done": return { kind: "done" };
    default: return { kind: "run", tool: name, args: input };
  }
}

// Prompt-shaping helpers — pure string building, no side effects. Turn
// SessionInput into a system prompt (the constitution) and a user message (the
// current state of the business). Sketched; a real impl would format the ledger
// tail, inbox, pending relay, and queue in full.
function renderConstitution(input: SessionInput): string {
  const c = input.constitution;
  return [`You are the brain of "${c.name}". Mission: ${c.mission}`,
    "Hard rules (never violate):", ...c.hardRules.map((r) => `- ${r}`),
    `Per-session spend cap: $${c.moneyCaps.perSessionUsd}. Act only via the provided tools.`,
  ].join("\n");
}

function renderState(input: SessionInput, history: Turn[]): string {
  return [
    `STATE.md:\n${input.state}`,
    `Recent journal:\n${input.journalTail}`,
    `Budget remaining this session: $${input.budget.remainingUSD}`,
    `Inbox messages: ${input.inbox.length}. Pending relay: ${input.pendingRelay.length}. Queue: ${input.queue.length}.`,
    history.length ? `You have already acted ${history.length} time(s) this session.` : "First step this session.",
  ].join("\n\n");
}
```

### Notes on the adapter

- **Key indirection.** `new Anthropic()` reads `ANTHROPIC_API_KEY` from the
  environment. The Brain has no key field, so a key can never end up in a config
  object, in `git`, or (per the gate's secret patterns) in a `write`/`notify`.
- **Model as config.** `model` is passed in (`"claude-opus-4-8"`, `"claude-sonnet-5"`,
  etc.), never hard-coded, so operators can pick their cost/quality point.
- **Tool-use → Actions.** Each Action kind is one Anthropic tool; `run` tools are
  added from `SessionInput.tools` at request time. `toAction` maps a `tool_use`
  block back to the exact discriminated-union shape the gate expects.
- **Faithful, not exhaustive.** A production adapter would add retries/backoff,
  optionally stream, thread multi-turn context through `messages` (not just a
  one-shot summary), and enforce the statelessness/error/timeout rules above —
  catch provider errors and degrade to a `notify` + `done` rather than throwing.

See [roadmap.md](./roadmap.md) for where a first-party `@mainspring/brain-claude`
adapter and a `ToolRegistry`-wired loop sit in the plan, and
[architecture.md](./architecture.md) for the trust boundary this Brain plugs into.
