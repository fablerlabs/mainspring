# @mainspring/governance API

Constitution-as-code: hard rules the brain cannot override, loaded from a
`CONSTITUTION.md` and enforced as `Action` guards. Zero runtime dependencies.
The package doc comment claims the whole package "never throws; no network" —
that holds for `rules.ts` and `guard.ts`, but **not** for the loader's file-reading
entry point: `loadConstitutionFile()` does local disk I/O via `node:fs/promises`
(no network call, so that half is accurate) and *does* reject/throw when the
file can't be read (e.g. missing path). This is confirmed by the package's own
test suite (`loadConstitutionFile("/nonexistent/...")` is asserted to reject).
Everything that operates on markdown/Action values already in memory
(`parseHardRules`, `attachConstitutionDescriptions`, `loadConstitutionRules`,
`evaluate`, `checkSpendPolicy`, `createBuiltInRules`) genuinely never throws —
malformed or hostile input degrades gracefully rather than raising.

## Exports

### `rules.ts`

#### `type Action`

```ts
type Action =
  | { kind: "run"; tool: string; args: unknown }
  | { kind: "write"; path: string; content: string }
  | { kind: "ledger"; entry: { date: string; type: "revenue" | "expense" | "refund" | "adjustment"; description: string; amountUsd: number } }
  | { kind: "enqueue"; order: unknown }
  | { kind: "relay"; request: unknown }
  | { kind: "notify"; to: "owner"; text: string; priority?: "high" }
  | { kind: "done" };
```

A structural mirror of `@mainspring/core`'s `Action` union (see
`packages/core/src/types.ts`). This package re-declares the shape rather than
importing it, specifically so `@mainspring/governance` has zero runtime
dependencies (including no build-order dependency on `@mainspring/core`). Any
real `core` `Action` value satisfies this type as-is; you can pass core
`Action`s straight into `evaluate()`.

#### `type Verdict`

```ts
type Verdict = "allow" | "block" | "escalate";
```

The outcome of checking an action against a rule (or a whole rule set).
Precedence when combining verdicts across rules: `block` beats `escalate`
beats `allow`.

#### `interface Rule`

```ts
interface Rule {
  id: string;
  description: string;
  test(action: Action): Verdict;
}
```

A single named guard. `test()` is a pure function from `Action` to `Verdict`;
`id` is a stable identifier used both to report which rule fired and to let a
constitution's `<!-- rule:ID -->` markers attach human-readable prose to a
specific built-in rule (see `attachConstitutionDescriptions`).

#### `interface MoneyCaps`

```ts
interface MoneyCaps {
  perSessionUsd: number;
  notifyAboveUsd: number;
  approvalAboveUsd: number;
}
```

Mirrors core's `MoneyCaps`. The money policy a workspace's Constitution sets:
a hard per-session expense ceiling, a threshold above which spend must be
notified, and a (higher) threshold above which spend needs an out-of-band
approval code.

#### `interface GovernanceConfig`

```ts
interface GovernanceConfig {
  moneyCaps?: MoneyCaps;
  spentSoFarUsd?: number;
  approvalCodePresent?: boolean;
  allowedTools?: string[];
  postToolPattern?: RegExp;
}
```

Live workspace policy passed into `createBuiltInRules()` (and, transitively,
`loadConstitutionRules()` / `loadConstitutionFile()`). Every field is optional;
omitting a field leaves the corresponding rule inert (always `allow`) rather
than defaulting to a restrictive policy — see each rule below for exactly what
it governs.

- `moneyCaps` — enforced by the `spend-caps` rule. Omit to leave spend
  ungoverned by this rule.
- `spentSoFarUsd` — running total of expense actions already applied so far
  this session (defaults to `0` if omitted). Used to compute projected spend
  against `perSessionUsd`.
- `approvalCodePresent` — whether the current session carries an
  owner-supplied approval code (defaults to `false`). This is session-level
  config supplied by the caller, never something derived from an `Action`'s
  own payload text (see the adversarial tests below).
- `allowedTools` — enforced by the `external-allowlist` rule: `run` actions
  whose `tool` is not in this list are blocked. Omit to leave `run` actions
  ungoverned by this rule (e.g. when a workspace enforces tool access
  elsewhere, as core's gate does).
- `postToolPattern` — enforced by the `honesty-disclosure` rule: a `run`
  action whose `tool` matches this pattern is treated as posting/publishing to
  an external audience, and its `args` must carry `disclosedAsAI: true`.
  Defaults to `/post|publish|tweet|comment|reply|reddit|hn|hacker-?news/i`.

#### `createBuiltInRules(config?: GovernanceConfig): Rule[]`

Builds the full built-in rule set, closing over the workspace's live policy
`config` (default `{}`, i.e. every optional-policy rule inert). Never throws.
Returns exactly four rules, always in this order:

1. **`no-secrets`** — "No secret-shaped strings may leave via a write, notify,
   or run/publish action." Applies to `write` (`content`), `notify` (`text`),
   and `run` (`JSON.stringify(args)`, falling back to `String(args)` if
   `args` isn't serializable) — the only `Action` kinds that can carry
   free-form outbound text. `enqueue`, `relay`, `ledger`, and `done` never
   fire this rule (they carry no free-form text). The action's text is tested
   against a fixed list of secret-shaped regexes (PEM private-key headers,
   Stripe `sk-`/`sk_live_`/`sk_test_` keys, GitHub `gh[pousr]_` tokens, AWS
   `AKIA...` access-key IDs, generic `*_API_KEY=`/`*_SECRET=`/`*_TOKEN=`
   assignments, `AWS_*=` assignments). Fires `block` on a match, `allow`
   otherwise. This is deliberately coarser than `@mainspring/scrub` — it
   exists to catch an obviously leaking `Action`, not to replace a scrub pass,
   and it is always active regardless of `config` (there is no way to turn it
   off).
2. **`spend-caps`** — "Expense ledger entries must respect the per-session cap
   and the notify/approval thresholds." Only applies to `ledger` actions, and
   only when `config.moneyCaps` is set (otherwise always `allow`). Delegates
   the actual verdict to `checkSpendPolicy(action.entry, config.moneyCaps,
   config.spentSoFarUsd ?? 0, config.approvalCodePresent ?? false)` (see
   below).
3. **`external-allowlist`** — "A `run` action's tool must be in the
   workspace's declared external-action allowlist." Only applies to `run`
   actions, and only when `config.allowedTools` is set (otherwise always
   `allow`). `block`s any `run` whose `tool` isn't an exact string match in
   `allowedTools`; otherwise `allow`.
4. **`honesty-disclosure`** — "A post/publish-shaped run action must carry
   `args.disclosedAsAI === true`." Only applies to `run` actions whose `tool`
   matches `config.postToolPattern` (or the default pattern above; the match
   is case-insensitive and unanchored, i.e. a substring match anywhere in the
   tool name). When it matches, the action is `allow`ed only if `args` is a
   non-null object with `disclosedAsAI` **strictly equal to `true`** — any
   other truthy-looking value (`"true"`, `1`, `"yes"`, `{}`, `[]`) is treated
   as *not* disclosed and the action is `block`ed. Non-matching tool names
   always `allow`.

#### `checkSpendPolicy(entry, caps, spentSoFarUsd, approvalCodePresent): Verdict`

```ts
function checkSpendPolicy(
  entry: { type: "revenue" | "expense" | "refund" | "adjustment"; amountUsd: number },
  caps: MoneyCaps,
  spentSoFarUsd: number,
  approvalCodePresent: boolean,
): Verdict
```

The standalone, independently testable decision function that the
`spend-caps` rule delegates to. Never throws. Decision order:

1. If `entry.type !== "expense"` (i.e. `revenue`, `refund`, or `adjustment`),
   always `allow` — only expenses are capped.
2. **Fail closed on a malformed amount**: if `entry.amountUsd` is not
   `Number.isFinite` (`NaN`, `Infinity`, `-Infinity`), `block` outright — even
   with `approvalCodePresent: true`. This exists because a compromised brain
   builds `Action` objects directly (bypassing JSON, which has no
   NaN/Infinity), and a garbage `amountUsd` would otherwise compare `false`
   against every threshold below and silently fall through to `allow`.
3. Compute `projected = spentSoFarUsd + entry.amountUsd`. If `projected >
   caps.perSessionUsd`, `block` — this is absolute and cannot be overridden by
   an approval code.
4. Else if `entry.amountUsd >= caps.approvalAboveUsd`: `allow` if
   `approvalCodePresent`, else `escalate`. A valid approval code clears this
   gate outright; it supersedes the notify-only threshold below rather than
   falling through to it.
5. Else if `entry.amountUsd >= caps.notifyAboveUsd`: `escalate` (notify-only;
   an approval code does not lower this into an `allow` — it only matters at
   the approval tier).
6. Otherwise `allow`.

Both `notifyAboveUsd` and `approvalAboveUsd` are inclusive thresholds (an
amount exactly equal to either boundary already triggers that tier), while
`perSessionUsd` blocks only when projected spend is *strictly greater than*
the cap (spending exactly up to the cap is allowed).

### `guard.ts`

#### `type FiredRule`

```ts
interface FiredRule {
  id: string;
  description: string;
  verdict: Verdict;
}
```

A record of one rule that did not return `allow` for a given action, carrying
that rule's `id`/`description` snapshot and the verdict it returned.

#### `type GuardResult`

```ts
interface GuardResult {
  verdict: Verdict;
  firedRules: FiredRule[];
}
```

The result of `evaluate()`: the combined verdict across all rules, plus the
list of rules that fired (in the order they were checked), for reporting why
an action was blocked/escalated.

#### `evaluate(action: Action, rules: Rule[]): GuardResult`

Evaluates one `Action` against a rule set.

- Runs every rule in `rules`, in array order — there is **no short-circuiting**:
  even after one rule returns `block`, every remaining rule still runs and any
  non-`allow` verdict it returns is still recorded in `firedRules`.
- `block` beats `escalate` beats `allow`: the returned `verdict` is the
  highest-precedence verdict seen across all rules (an empty rule set, or a
  rule set where every rule returns `allow`, yields `verdict: "allow"` and an
  empty `firedRules`).
- A rule is considered "fired" if it returns anything other than `allow`;
  fired rules are pushed onto `firedRules` in the order they ran, regardless
  of whether they end up being the highest-precedence verdict.
- **Never throws**: if a rule's `test()` throws, `evaluate()` catches it and
  treats that rule as if it had returned `"escalate"` (it is recorded in
  `firedRules` with `verdict: "escalate"`) — governance fails closed rather
  than the session crashing on a buggy or hostile custom rule.

### `loader.ts`

#### `interface ParsedHardRule`

```ts
interface ParsedHardRule {
  id?: string;
  text: string;
}
```

One bullet parsed out of a constitution's `## Hard rules` section. `id` is
present only when the source line carried a `<!-- rule:ID -->` HTML-comment
marker; otherwise it is `undefined`.

#### `parseHardRules(markdown: string): ParsedHardRule[]`

Best-effort parser for a `CONSTITUTION.md`'s `## Hard rules` section. Never
throws. Behavior:

- Finds the first line matching `/^##\s+Hard rules\b/i` (case-insensitive,
  requires the `##` heading level exactly, e.g. `## Hard rules`). If no such
  line exists, **returns `[]`** — this is not an error, just an empty result.
- From the line after that heading, collects list items: lines matching a
  numbered (`1.`) or bulleted (`-`/`*`) list-item pattern start a new item;
  any following non-blank, non-list-item lines are treated as a wrapped
  continuation and appended (single-space-joined) to the current item; a
  blank line or the next `##`-level heading ends the section/flushes the
  current item.
- Whitespace inside each collected item's text is collapsed (`\s+` → single
  space) and trimmed. Items whose text is empty after trimming are dropped.
- If a `<!-- rule:ID -->` marker (an alphanumeric/`_`/`-` id) appears anywhere
  in the collected text, it is extracted into the item's `id` and stripped
  from the visible `text`; items with no marker have `id: undefined`. A
  constitution with no markers at all still parses fine — its items just all
  lack an `id`, which (per `attachConstitutionDescriptions`) never overrides
  a built-in rule's description.
- Malformed/non-markdown input (garbage text, no `## Hard rules` heading,
  stray HTML) does not throw; it simply yields fewer or zero items.

#### `attachConstitutionDescriptions(rules: Rule[], parsed: ParsedHardRule[]): Rule[]`

Attaches human-readable constitution prose to built-in rules by `id` match.
Never throws. For each rule in `rules`, if any `parsed` item has an `id`
matching that rule's `id`, returns a **new** rule object (shallow-copied via
spread) whose `description` becomes `` `${original description} (constitution: "${prose}")` ``.
Rules with no matching parsed item are returned unchanged (same object, kept
verbatim). This only ever edits the human-readable `description` string — a
constitution cannot use this mechanism to change a rule's actual `test()`
enforcement (the adversarial test suite exercises exactly this: a "hostile"
constitution claims via `<!-- rule:no-secrets -->` prose that secrets may be
freely posted, and via `<!-- rule:spend-caps -->` prose that any spend is
fine; enforcement is unaffected in both cases).

#### `interface LoadedConstitution`

```ts
interface LoadedConstitution {
  hardRules: ParsedHardRule[];
  rules: Rule[];
}
```

- `hardRules` — every hard-rule bullet found, in document order, regardless of
  whether it carried an id marker.
- `rules` — the built-in rules (from `createBuiltInRules`), with descriptions
  enriched from any matching id-marked bullets.

#### `loadConstitutionRules(markdown: string, config?: GovernanceConfig): LoadedConstitution`

Parses `markdown` and builds the enriched built-in rule set in one call:
`{ hardRules: parseHardRules(markdown), rules: attachConstitutionDescriptions(createBuiltInRules(config), hardRules) }`.
Never throws (it's pure composition of two functions that never throw), even
for an empty string, non-markdown garbage, or a constitution whose prose
tries to claim rules are disarmed. `rules.length` always equals
`createBuiltInRules().length` (4) regardless of input — the built-in rule set
itself is not something the markdown can add to, remove from, or disable; the
markdown can only annotate descriptions.

#### `loadConstitutionFile(path: string, config?: GovernanceConfig): Promise<LoadedConstitution>`

Convenience wrapper: `readFile(path, "utf8")` then `loadConstitutionRules(markdown, config)`.

**This is the one export that does not honor "never throws."** It performs
local filesystem I/O (`node:fs/promises`, no network involved) and its
returned promise **rejects** if the read fails — e.g. a missing file, a
directory instead of a file, or a permissions error — propagating whatever
error `fs.readFile` raises. The package's own adversarial test suite asserts
this directly: loading a nonexistent path must reject rather than silently
resolve to an empty, permissive `LoadedConstitution`. Callers must `await`/
`.catch()` or wrap it in `try { } catch { }` — treat a failed load as "no
constitution available," not as "everything is allowed."

## Common flows

### Load a constitution file and enforce it against an action

```ts
import { loadConstitutionFile } from "@mainspring/governance";
import { evaluate } from "@mainspring/governance";

// May reject if the file is missing/unreadable — this is the one export
// that can throw, per the docs above.
const { hardRules, rules } = await loadConstitutionFile(
  "examples/hello-business/CONSTITUTION.md",
  { moneyCaps: { perSessionUsd: 100, notifyAboveUsd: 25, approvalAboveUsd: 75 } },
);

const result = evaluate(
  { kind: "ledger", entry: { date: "2026-07-07", type: "expense", description: "hosting", amountUsd: 30 } },
  rules,
);

if (result.verdict !== "allow") {
  console.log(result.verdict, result.firedRules); // e.g. "escalate", [{ id: "spend-caps", ... }]
}
```

### Build rules in-memory (no file I/O) and evaluate an action

```ts
import { createBuiltInRules, evaluate } from "@mainspring/governance";

const rules = createBuiltInRules({
  allowedTools: ["send-email"],
});

const result = evaluate(
  { kind: "run", tool: "post-to-reddit", args: { text: "hello" } },
  rules,
);
// result.verdict === "block"
// result.firedRules includes both "external-allowlist" (tool not allowed)
// and "honesty-disclosure" (no disclosedAsAI: true) — evaluate never
// short-circuits, so both fire on the same action.
```
