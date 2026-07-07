# @mainspring/core API Reference

`@mainspring/core` is the swappable-brain contract and the
constitution-enforcing session loop for Mainspring. A `Brain` is pure
reasoning: given the current state of the business it proposes a list of
`Action`s, but it never touches the filesystem, the network, or a secret
directly. The session loop — `assemble` → `brain.step` → `gate` → `dispatch`
— is the only code that ever executes a side effect, and it does so only
after every `Action` has been checked against the workspace's `Constitution`.
This split is what makes the brain swappable: any model/provider can
implement `step()` and be dropped in without touching the trust boundary.

This document covers every symbol exported from `src/index.ts`. Note that
`packages/core/test/gate.test.ts` is the only test file in this package —
`gate.ts` (`gateAction`/`gateActions`) has direct unit coverage; `assemble.ts`,
`defineConfig.ts`, `dispatch.ts`, `loop.ts`, and `echoBrain.ts` have no
dedicated unit tests in this package and are only exercised indirectly (e.g.
via `examples/quickstart`). Behavior for those files below is derived solely
from reading the source.

## Exports

- Types (re-exported from `types.js`): `Action`, `Brain`, `Constitution`,
  `GateDecision`, `HealthReport`, `LedgerEntry`, `Money`, `MoneyCaps`,
  `OwnerMessage`, `RelayRequest`, `SessionInput`, `SessionSummary`,
  `StepResult`, `ToolSpec`, `Turn`, `Usage`, `WorkOrder`, `DispatchResult`
- Values/functions: `defineConfig`, `assemble`, `gateAction`, `gateActions`,
  `applyAction`, `applyActions`, `isWithinWorkspace`, `runSession`,
  `EchoBrain`
- Supporting types for those functions: `MainspringConfig`, `GateContext`,
  `DispatchContext`, `RunSessionOptions`

---

## types.ts — core data contracts

These are plain interfaces/type aliases with no runtime behavior — they
describe the shapes that flow between `assemble`, a `Brain`, `gate`, and
`dispatch`.

### `Money`

```ts
interface Money {
  usd: number;
}
```

A dollar amount. Used by `Brain.estimateCost()`.

### `Usage`

```ts
interface Usage {
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
}
```

Token/time accounting for a single `brain.step()` call. `EchoBrain` always
returns `{ inputTokens: 0, outputTokens: 0, wallMs: 0 }`.

### `LedgerEntry`

```ts
interface LedgerEntry {
  date: string; // ISO 8601
  type: "revenue" | "expense" | "refund" | "adjustment";
  description: string;
  amountUsd: number; // positive number; sign is implied by `type`
}
```

One line of the append-only business ledger. `amountUsd` is always
non-negative — direction (`+`/`-`) comes from `type`, not sign. `gateAction`
rejects any ledger entry with `amountUsd < 0`. `dispatch.ts`'s `applyAction`
computes the running balance delta as `+amountUsd` for `revenue`, `-amountUsd`
for `expense`/`refund`, and `0` for `adjustment`.

### `WorkOrder`

```ts
interface WorkOrder {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}
```

A unit of work the brain wants done later (by itself or a human/lane). An
`enqueue` action writes one of these to `queue/<id>.json`.

### `RelayRequest`

```ts
interface RelayRequest {
  id: string;
  summary: string;
  detail: string;
  estimateMinutes?: number;
  createdAt: string;
}
```

A blocker only a human can clear (account creation, CAPTCHA, payment,
approval). A `relay` action writes one of these to `relay/pending/<id>.json`.

### `OwnerMessage`

```ts
interface OwnerMessage {
  id: string;
  receivedAt: string;
  text: string;
  approvalCode?: string;
}
```

A message from the owner/operator, delivered out-of-band. `assemble` reads
every `*.json` file under `inbox/` in a workspace and parses each as an
`OwnerMessage`.

### `HealthReport`

```ts
interface HealthReport {
  ok: boolean;
  lastSessionFailed: boolean;
  notes: string[];
}
```

Result of the self-maintenance / supervisor health check, read by `assemble`
from `health.json`. If the file is missing or empty, `assemble` defaults to
`{ ok: true, lastSessionFailed: false, notes: [] }`. If it exists but fails
to parse as JSON, `assemble` substitutes
`{ ok: false, lastSessionFailed: false, notes: ["health.json is not valid JSON"] }`
rather than throwing.

### `ToolSpec`

```ts
interface ToolSpec {
  name: string;
  description: string;
  argsSchema?: unknown;
}
```

A tool the brain is allowed to request via a `run` action. `gateAction`
checks a `run` action's `tool` name against the list of `ToolSpec.name`s in
`GateContext.tools`; unknown tool names are blocked.

### `Turn`

```ts
interface Turn {
  role: "brain" | "loop";
  content: string;
  at: string;
}
```

One prior brain/loop exchange, passed as in-session history. `runSession`
appends one `{ role: "brain", content: JSON.stringify(stepResult.actions), at }`
turn after every step; `EchoBrain.step` uses `history.some(t => t.role === "brain")`
to detect it has already run once in this session.

### `MoneyCaps`

```ts
interface MoneyCaps {
  perSessionUsd: number;
  notifyAboveUsd: number;
  approvalAboveUsd: number;
}
```

- `perSessionUsd` — hard ceiling on total spend actioned in a single session.
  Enforced by `gateAction`/`gateActions`, which block any `expense` ledger
  entry that would push cumulative session spend over this number.
- `notifyAboveUsd` / `approvalAboveUsd` — declared here as data, but as of
  this version of the package **`gate.ts` does not read or enforce
  `notifyAboveUsd` or `approvalAboveUsd`** — only `perSessionUsd` is checked
  in code. They exist for a caller (e.g. a Brain or an outer harness) to
  consult when deciding whether to also emit a `notify` action.

### `Constitution`

```ts
interface Constitution {
  name: string;
  mission: string;
  hardRules: string[];
  moneyCaps: MoneyCaps;
  maxSessionMs: number;
}
```

The governing document a workspace is booted with. `hardRules` is
plain-English text — the gate does not parse or match against it
structurally in this version; only the structural checks in `gateAction`
(workspace escape, forbidden targets, secret patterns, money caps, tool
allow-list) are enforced in code. `maxSessionMs` is surfaced to a `Brain` via
`SessionInput.budget.sessionMs`; `runSession` does not itself enforce a wall
clock against it (its own safety valve is the step-count `maxSteps` option).

### `SessionInput`

```ts
interface SessionInput {
  constitution: Constitution;
  state: string;
  journalTail: string;
  ledgerTail: LedgerEntry[];
  inbox: OwnerMessage[];
  health: HealthReport;
  pendingRelay: RelayRequest[];
  queue: WorkOrder[];
  tools: ToolSpec[];
  budget: {
    remainingUSD: number;
    sessionMs: number;
  };
}
```

Everything a `Brain` sees to decide what to do next; built fresh every step
by `assemble()`. See `assemble.ts` below for exactly how each field is
populated.

### `Action`

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

The only vocabulary a `Brain` can act in. Every `kind` is validated by
`gateAction` and, if allowed, executed by `applyAction`. `kind: "done"` is
never blocked and, when applied, is a no-op recorded as
`{ applied: true, detail: "session marked done" }`.

### `StepResult`

```ts
interface StepResult {
  actions: Action[];
  usage: Usage;
  done: boolean;
}
```

What a `Brain` returns from one reasoning step. `runSession` treats the
session as finished when either `stepResult.done` is `true` or any proposed
action has `kind: "done"`.

### `Brain`

```ts
interface Brain {
  readonly id: string;
  readonly model: string;
  step(input: SessionInput, history: Turn[]): Promise<StepResult>;
  estimateCost?(usage: Usage): Money;
}
```

The pluggable-reasoning contract. `estimateCost` is optional — no code in
this package currently calls it (it is not invoked from `loop.ts`). The only
implementation shipped in this package is `EchoBrain`.

### `GateDecision`

```ts
interface GateDecision {
  action: Action;
  allowed: boolean;
  reason?: string;
}
```

Outcome of running one `Action` through the gate. `reason` is present when
`allowed` is `false` (and absent — `undefined` — for most allowed
decisions); `runSession` falls back to the literal string
`"blocked with no reason given"` if a blocked decision ever lacks a reason.

### `DispatchResult`

```ts
interface DispatchResult {
  action: Action;
  applied: boolean;
  detail?: string;
}
```

Outcome of dispatching one allowed `Action`. `applied` is `false` only for a
`run` action whose tool has no registered handler (see `applyAction` below);
every other action kind always applies successfully once it reaches
`dispatch.ts` (gate.ts is assumed to have already filtered out anything that
shouldn't run).

### `SessionSummary`

```ts
interface SessionSummary {
  startedAt: string;
  endedAt: string;
  steps: number;
  actionsProposed: number;
  actionsAllowed: number;
  actionsBlocked: number;
  blockedReasons: string[];
  spentUsd: number;
  done: boolean;
}
```

Summary written by `runSession` at the end of a session (also persisted to
`.mainspring/last-session.json` with an added `commitDetail` field, though
`commitDetail` is not part of this exported type).

---

## defineConfig.ts

### `MainspringConfig`

```ts
interface MainspringConfig {
  constitution: Constitution;
  brain: Brain;
}
```

A workspace's typed config: which `Constitution` governs it, which `Brain`
runs it.

### `defineConfig(config: MainspringConfig): MainspringConfig`

Identity function — returns `config` unchanged. Its only purpose is to give
editor autocomplete/type-checking to `mainspring.config.ts` files (the same
pattern as `defineConfig` in Vite/Vitest, etc.). Never throws.

```ts
import { defineConfig, EchoBrain } from "@mainspring/core";

const config = defineConfig({
  constitution: {
    name: "My Business",
    mission: "Build and run a small, honest digital product.",
    hardRules: ["Legal and honest only.", "You are an AI and never claim otherwise."],
    moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
    maxSessionMs: 40 * 60_000,
  },
  brain: new EchoBrain(),
});
```

---

## assemble.ts — `assemble()`

```ts
function assemble(
  workspaceDir: string,
  constitution: Constitution,
  tools?: ToolSpec[], // default []
): Promise<SessionInput>
```

Reads a workspace directory on disk and builds the `SessionInput` a `Brain`
will see. This is the only place in the package that reads the filesystem to
gather context (as opposed to writing it, which is `dispatch.ts`'s job).

Behavior, field by field:

- Ensures `journal/`, `inbox/`, `relay/pending/`, and `queue/` subdirectories
  exist under `workspaceDir` (creates them recursively if missing; never
  throws for a missing directory).
- `state` — contents of `STATE.md` in the workspace root, or `""` if the
  file doesn't exist or can't be read.
- `journalTail` — contents of `journal/<today's-ISO-date>.md`, or `""` if
  missing. "Today" is computed from `new Date().toISOString().slice(0, 10)`
  at call time, in UTC.
- `ledgerTail` — parses `LEDGER.csv` (skips the header row; a row missing
  `date`, `type`, or `amount` is silently dropped) and returns at most the
  last 20 entries. Returns `[]` if the file is missing, empty, or header-only.
- `inbox` — every `*.json` file in `inbox/`, parsed as `OwnerMessage`, in
  filename-sorted order. Files that fail to `JSON.parse` are silently
  skipped (not thrown).
- `pendingRelay` — same pattern, over `relay/pending/`, parsed as
  `RelayRequest[]`.
- `queue` — same pattern, over `queue/`, parsed as `WorkOrder[]`.
- `health` — parsed from `health.json`; defaults to
  `{ ok: true, lastSessionFailed: false, notes: [] }` if the file is missing
  or blank, or to an `ok: false` report with an explanatory note if the file
  exists but isn't valid JSON (see `HealthReport` above).
- `tools` — passed through unchanged from the `tools` argument (default `[]`).
- `budget.remainingUSD` — `constitution.moneyCaps.perSessionUsd` minus the
  sum of every `expense`-type `LedgerEntry.amountUsd` found in the **full**
  ledger CSV (not just the last-20 tail), clamped to a minimum of `0`. Despite
  the internal helper's name (`spentThisSession`), this sums *all* expense
  rows ever written to `LEDGER.csv`, not merely the current session's spend.
- `budget.sessionMs` — `constitution.maxSessionMs`, passed through unchanged.

Never throws: every filesystem read is wrapped so a missing/unreadable file
degrades to an empty/default value instead of propagating an error.

```ts
import { assemble } from "@mainspring/core";

const input = await assemble("./my-business", constitution, [
  { name: "http.get", description: "fetch a URL" },
]);
console.log(input.budget.remainingUSD, input.pendingRelay.length);
```

---

## gate.ts — `gateAction()`, `gateActions()`

### `GateContext`

```ts
interface GateContext {
  constitution: Constitution;
  workspaceDir: string;
  spentSoFarUsd: number; // sum of expense amounts already dispatched this session
  tools: ToolSpec[];
}
```

### `gateAction(action: Action, ctx: GateContext): GateDecision`

Validates a single proposed `Action` against the constitution and returns an
allow/block decision plus (when blocked) a human-readable `reason`. Never
throws and never performs a side effect — it is pure decision logic; only
`dispatch.ts` acts on an `allowed: true` result. Per `kind`:

- `"write"` — blocked if `action.path` resolves outside `ctx.workspaceDir`
  (reason matches `/escapes workspace/`); blocked if the path is/contains
  `.env` or `.git` as a path segment (reason matches `/forbidden file/`);
  blocked if `action.content` matches one of the secret-like regexes (PEM
  private key headers, `sk-`-prefixed API-key-shaped tokens, `*API_KEY=...`,
  `*SECRET=...`, `AWS_*=...`) (reason matches `/secret-like pattern/`).
  Otherwise allowed.
- `"ledger"` — blocked if `entry.amountUsd < 0` (ledger entries must express
  direction via `type`, not a negative amount). If `entry.type === "expense"`,
  blocked if `ctx.spentSoFarUsd + entry.amountUsd` would exceed
  `ctx.constitution.moneyCaps.perSessionUsd` (reason matches
  `/exceeding the per-session cap/`). `revenue`, `refund`, and `adjustment`
  entries are never capped. Otherwise allowed.
- `"notify"` — blocked if `action.text` matches a secret-like pattern (same
  regex set as `"write"`). Otherwise allowed.
- `"run"` — blocked if `action.tool` is not present by name in `ctx.tools`.
  Otherwise allowed.
- `"enqueue"`, `"relay"`, `"done"` — always allowed unconditionally.

Note: `ctx.constitution.moneyCaps.notifyAboveUsd` and `approvalAboveUsd` are
part of the `MoneyCaps` type but are **not read anywhere in `gateAction`** —
only `perSessionUsd` gates anything in this version of the code.

```ts
const decision = gateAction(
  { kind: "ledger", entry: { date: "2026-01-01T00:00:00.000Z", type: "expense", description: "domain renewal", amountUsd: 12 } },
  { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
);
// decision.allowed === true
```

### `gateActions(actions: Action[], ctx: GateContext): GateDecision[]`

Runs `gateAction` over a list of actions in order, threading a running
`spentSoFarUsd` total: every time an action is both allowed and is an
`expense`-type `ledger` entry, its `amountUsd` is added to the running total
used to evaluate the *next* action in the list. This is what lets two
individually-under-cap expenses in the same batch be blocked once their sum
crosses `perSessionUsd` (see `gate.test.ts`, "a sequence of expenses is
blocked once their running total crosses the cap").

```ts
const decisions = gateActions(
  [
    { kind: "ledger", entry: { date: now, type: "expense", description: "a", amountUsd: 15 } },
    { kind: "ledger", entry: { date: now, type: "expense", description: "b", amountUsd: 15 } },
  ],
  { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
);
// decisions[0].allowed === true, decisions[1].allowed === false
```

---

## dispatch.ts — `applyAction()`, `applyActions()`, `isWithinWorkspace()`

### `DispatchContext`

```ts
interface DispatchContext {
  workspaceDir: string;
  toolRegistry?: ToolRegistry; // Record<string, (args: unknown) => Promise<unknown>>
}
```

`toolRegistry` maps a `ToolSpec.name` to the actual async handler that
performs a `run` action's real work. A `Brain` only ever sees the
declarative `ToolSpec`; the handler lives on the trusted side of the loop
and is supplied by whoever wires up the workspace (it is not exported from
this package).

### `applyAction(action: Action, ctx: DispatchContext): Promise<DispatchResult>`

Applies one **already gate-allowed** `Action` to the workspace on disk. This
is the only module in the package that performs a filesystem write; it
assumes the caller (`runSession`) already ran the action through
`gateAction`/`gateActions` — it performs no re-validation of workspace
escape, forbidden paths, or secret content itself. Per `kind`:

- `"write"` — resolves `action.path` against `ctx.workspaceDir`, creates any
  missing parent directories, writes `action.content` as UTF-8 (overwriting
  if the file exists). Returns `{ applied: true, detail: "wrote <path>" }`.
- `"ledger"` — ensures `LEDGER.csv` exists (writing the header row
  `date,type,description,amount,balance` if not), reads the previous
  trailing balance from the last non-empty line, computes a new balance by
  applying `ledgerDelta` (`+amountUsd` for `revenue`, `-amountUsd` for
  `expense`/`refund`, `0` for `adjustment`), appends a CSV row (fields with
  commas/quotes/newlines are quoted/escaped), and returns
  `{ applied: true, detail: "ledger balance now $<balance>" }`.
- `"enqueue"` — writes `action.order` as pretty-printed JSON to
  `queue/<order.id>.json`. Always overwrites if a file with that id already
  exists (no dedupe/merge). Returns `{ applied: true, detail: "enqueued <id>" }`.
- `"relay"` — writes `action.request` as pretty-printed JSON to
  `relay/pending/<request.id>.json`. Returns
  `{ applied: true, detail: "filed relay request <id>" }`.
- `"notify"` — appends one timestamped line
  (`<ISO time> [<priority ?? "normal">] <text>`) to
  `outbox/notifications.log`. Returns
  `{ applied: true, detail: "queued in outbox/notifications.log" }`.
- `"run"` — looks up `ctx.toolRegistry?.[action.tool]`. **If no handler is
  registered, this is the one case where dispatch does not throw but instead
  returns `{ applied: false, detail: 'no handler registered for tool "<tool>"' }`
  without executing anything.** If a handler is found, it is awaited and its
  result JSON-stringified into the detail; if the handler itself throws, that
  rejection propagates out of `applyAction` (not caught here).
- `"done"` — no filesystem effect; returns
  `{ applied: true, detail: "session marked done" }`.

```ts
const result = await applyAction(
  { kind: "write", path: "journal/2026-07-07.md", content: "# hello\n" },
  { workspaceDir: "./my-business" },
);
// result.detail === "wrote journal/2026-07-07.md"
```

### `applyActions(actions: Action[], ctx: DispatchContext): Promise<DispatchResult[]>`

Applies each action in `actions` sequentially (awaiting each before starting
the next) via `applyAction`, and returns the results in the same order. If
any individual `applyAction` call rejects (only possible via a throwing
`run` tool handler), the rejection propagates and later actions in the list
are not attempted.

### `isWithinWorkspace(workspaceDir: string, targetPath: string): boolean`

Resolves `targetPath` against `workspaceDir` and checks whether the result
still starts with the resolved, separator-terminated `workspaceDir`. Used
internally by `dispatch.ts`'s consumers to check "does this touch the
workspace" before trusting a path; note `gate.ts` defines its own private
copy of this exact same check rather than importing it — the two
implementations are logically identical but not literally shared code.

```ts
isWithinWorkspace("/tmp/workspace", "journal/today.md"); // true
isWithinWorkspace("/tmp/workspace", "../../etc/passwd"); // false
```

---

## loop.ts — `runSession()`

### `RunSessionOptions`

```ts
interface RunSessionOptions {
  workspaceDir: string;
  constitution: Constitution;
  brain: Brain;
  tools?: ToolSpec[]; // default []
  maxSteps?: number; // default 25 — safety valve independent of brain's own `done` flag
  commit?: boolean; // default true — set false to skip `git add && git commit` (used by tests)
}
```

### `runSession(options: RunSessionOptions): Promise<SessionSummary>`

Runs one Mainspring session end to end: assemble context, call the `Brain`
in a loop, gate every proposed `Action` against the constitution, dispatch
what's allowed, then commit the workspace. This function is the whole trust
boundary of the package — it is the only caller of `gateActions` and
`applyActions`.

Loop mechanics:

1. While not `done` and `steps < maxSteps`:
   - Re-`assemble()`s a fresh `SessionInput` from `workspaceDir` on every
     iteration (so a `Brain` sees the effects of its own previous step,
     e.g. an updated ledger/queue/inbox).
   - Calls `brain.step(input, history)`.
   - Runs the returned `actions` through `gateActions`, threading
     `spentUsd` (the running total of allowed `expense` ledger entries) in
     as `spentSoFarUsd`.
   - Dispatches only the allowed actions via `applyActions({ workspaceDir })`
     — note this `DispatchContext` never sets `toolRegistry`, so any `run`
     action dispatched through `runSession` will always resolve to
     `{ applied: false, detail: 'no handler registered...' }` unless a
     future version threads one through `RunSessionOptions`.
   - Appends a `{ role: "brain", ... }` turn to `history` with the raw
     JSON-stringified proposed actions (not just the allowed ones).
   - Sets `done = stepResult.done || stepResult.actions.some(a => a.kind === "done")`.
2. After the loop, if `commit` is true, attempts `git add -A` then, only if
   `git diff --cached --stat` is non-empty, `git commit -m "mainspring: session commit"`
   in `workspaceDir`. Any failure (e.g. not a git repo, no git binary) is
   caught and recorded as `commitDetail: "commit skipped: <error message>"`
   rather than thrown; a clean `git diff --cached --stat` yields
   `"nothing to commit"`.
3. Writes the resulting `SessionSummary` (plus `commitDetail`) to
   `.mainspring/last-session.json` in the workspace, creating that directory
   if needed.
4. Returns the `SessionSummary` (without `commitDetail`, which is only in
   the persisted JSON file, not the returned object's declared type).

Ambiguous/untested edge cases worth flagging: `maxSteps` being reached
without the brain ever returning `done` produces a summary with
`done: false` and no distinguishing signal from a normal completion other
than that flag; there is no dedicated test exercising this cutoff, the
`run`-action-with-no-registry path, or the git-commit failure path.

```ts
import { runSession, EchoBrain } from "@mainspring/core";

const summary = await runSession({
  workspaceDir: "./my-business",
  constitution,
  brain: new EchoBrain(),
});
console.log(summary.done, summary.spentUsd, summary.actionsBlocked);
```

---

## echoBrain.ts — `EchoBrain`

```ts
class EchoBrain implements Brain {
  readonly id = "echo";
  readonly model = "echo-deterministic";
  step(input: SessionInput, history: Turn[]): Promise<StepResult>;
  estimateCost(_usage: Usage): Money; // always { usd: 0 }
}
```

A deterministic, zero-API-key `Brain`. It performs no real reasoning: on its
first call in a session it always proposes exactly one `write` (appending a
heartbeat line to `journal/<today>.md`, prefixed with `input.journalTail` if
present or a fresh `# Journal — <date>` heading otherwise), one `ledger`
entry (`type: "adjustment"`, `amountUsd: 0`, description
`"echo heartbeat (no real spend)"`), and one `{ kind: "done" }`, with
`done: true`. Its purpose is to prove the loop — assemble → gate → dispatch
→ commit — works end to end with no network access and no credentials, so a
new workspace is runnable before any real model is wired up.

On any subsequent call within the same session (detected via
`history.some(t => t.role === "brain")` being true), `step` short-circuits
to `{ actions: [{ kind: "done" }], usage: zeroUsage(), done: true }` — i.e.
it never proposes the heartbeat write/ledger actions more than once per
session, regardless of how many steps `runSession` would otherwise allow.

`estimateCost` always returns `{ usd: 0 }` regardless of the `usage` passed
in — it ignores the argument entirely.

```ts
import { runSession, EchoBrain } from "@mainspring/core";

const summary = await runSession({
  workspaceDir: "./my-business",
  constitution,
  brain: new EchoBrain(),
  commit: false,
});
// summary.done === true; journal/<today>.md and LEDGER.csv now have one new entry each
```
