# @mainspring/ledger — API

The money module: append-only `LEDGER.csv` management with balance
invariants and spend-cap thresholds. Zero runtime dependencies; no LLM
calls; no network. `appendLedger` only ever appends new bytes to
`LEDGER.csv` — it never rewrites earlier rows, so a corrupted or
hand-edited row is caught by the balance invariant instead of loading
silently.

## Exports

### `src/ledger.ts`

#### `type LedgerEntryType`

```ts
type LedgerEntryType = "revenue" | "expense" | "refund" | "adjustment";
```

The four kinds of ledger entry. Each has a fixed signed effect on the
running balance (see "Balance invariant" below).

#### `interface LedgerEntry`

```ts
interface LedgerEntry {
  date: string; // ISO 8601
  type: LedgerEntryType;
  description: string;
  amountUsd: number;
}
```

One entry to record. `amountUsd` is always a non-negative magnitude; the
sign of its effect on the balance is implied by `type`, not by the sign of
`amountUsd` itself.

#### `interface LedgerRow`

```ts
interface LedgerRow extends LedgerEntry {
  balanceUsd: number;
}
```

A stored entry plus the running balance immediately after it. This is
what `Ledger.append`, `Ledger.entries`, `readLedger`, and `appendLedger`
all hand back — every row is frozen (`Object.freeze`) once created.

#### `LEDGER_CSV_HEADER`

```ts
const LEDGER_CSV_HEADER = "date,type,description,amount_usd,balance_usd";
```

The exact, required first line of every `LEDGER.csv` file. `Ledger.fromCsv`
rejects any document whose first non-blank line doesn't match this string
verbatim.

**CSV format.** Each subsequent line is one `LedgerRow`, five columns in
this order:

| column | source field | format |
|---|---|---|
| `date` | `LedgerEntry.date` | written as-is (expected ISO 8601, not reformatted) |
| `type` | `LedgerEntry.type` | one of the four `LedgerEntryType` strings |
| `description` | `LedgerEntry.description` | CSV-escaped: quoted (with `"` doubled) if it contains a comma, quote, or newline |
| `amount_usd` | `LedgerEntry.amountUsd` | `.toFixed(2)` — always two decimal places |
| `balance_usd` | `LedgerRow.balanceUsd` | `.toFixed(2)` — always two decimal places |

The full file is `LEDGER_CSV_HEADER + "\n"`, followed by one such line per
row, each terminated with `\n` (`Ledger.toCsv()`). Parsing is a small
hand-rolled CSV reader (`parseCsvLine`) that understands quoted fields and
doubled-quote escaping; it does not depend on any external CSV library.

#### `class LedgerInvariantError extends Error`

```ts
class LedgerInvariantError extends Error {
  constructor(message: string);
}
```

`name` is set to `"LedgerInvariantError"`. Thrown (never returned) whenever
stored or loaded ledger data is inconsistent. Concretely, thrown by:

- `Ledger.append` — if `entry.amountUsd` is not a finite, non-negative
  number.
- `Ledger.fromCsv` (and therefore `readLedger` / `appendLedger`, which call
  it) —
  - the first non-blank line doesn't equal `LEDGER_CSV_HEADER` exactly;
  - a data row doesn't have exactly 5 columns;
  - a row's `type` column isn't one of the four known `LedgerEntryType`
    values;
  - a row's `amount_usd` isn't a finite, non-negative number;
  - a row's `balance_usd` isn't a finite number;
  - **the balance invariant itself**: a row's `balance_usd`, rounded to
    cents, does not equal `roundCents(runningBalanceSoFar + delta(row))`,
    where `delta` is `+amountUsd` for `revenue`, `-amountUsd` for `expense`
    and `refund`, and `0` for `adjustment`. This is the core self-check —
    every row must carry a running balance consistent with every row
    before it, so a hand-edited or truncated file is caught at load time
    instead of silently producing a wrong balance.

No other error types are thrown by this module; disk I/O errors from
`node:fs/promises` propagate as-is (except that a missing `LEDGER.csv` is
treated as "empty", not an error — see `readLedger`).

#### `class Ledger`

Pure in-memory model: parse, append, serialize. No filesystem access.

```ts
class Ledger {
  get entries(): readonly LedgerRow[];
  balance(): number;
  append(entry: LedgerEntry): LedgerRow;
  toCsv(): string;
  static fromCsv(csv: string): Ledger;
}
```

- `entries` — rows in file order (oldest first), returned as a fresh,
  frozen copy (`Object.freeze(this.#rows.slice())`) each time; mutating
  the returned array (or attempting to, since it's frozen) cannot affect
  the ledger.
- `balance()` — the running balance after the last entry, or `0` for an
  empty ledger.
- `append(entry)` — validates `amountUsd` (throws `LedgerInvariantError` if
  negative or non-finite), computes the new balance from the current
  balance plus the entry's signed `delta`, rounds to cents
  (`Math.round(n * 100) / 100`), pushes a frozen `LedgerRow`, and returns
  it. Always adds to the end; there is no method to edit or remove a past
  row.
- `toCsv()` — serializes the full ledger (header + every row) as
  `LEDGER.csv` text, per the CSV format above.
- `static fromCsv(csv)` — parses a `LEDGER.csv` document into a new
  `Ledger`, re-deriving and checking the running balance for every row
  (see the balance-invariant list above). Blank lines are ignored. An
  empty string, or a document with only the header line, parses to an
  empty ledger.

#### `ledgerPath(workspaceDir: string): string`

Returns the absolute path to `LEDGER.csv` for a workspace:
`join(workspaceDir, "LEDGER.csv")`.

#### `readLedger(workspaceDir: string): Promise<Ledger>`

Reads `LEDGER.csv` from `ledgerPath(workspaceDir)` into a `Ledger`,
validating the balance invariant on every row via `Ledger.fromCsv`. If the
file does not exist, resolves to a fresh empty `Ledger` (does not throw).
If the file exists but is malformed or its balances don't reconcile,
rejects with `LedgerInvariantError`.

#### `appendLedger(workspaceDir: string, entry: LedgerEntry): Promise<LedgerRow>`

Appends one entry to `LEDGER.csv` on disk and returns the stored row.
Reads the current file only to validate the invariant and compute the new
balance (so a tampered existing file is caught here too, since it goes
through `Ledger.fromCsv`), then writes:

- if the file doesn't exist: creates parent directories
  (`mkdir(..., { recursive: true })`) and writes header + first row in one
  `writeFile`;
- if the file exists: `appendFile`s just the new row's line (adding a
  leading `\n` first only if the existing content didn't already end with
  one) — existing bytes on disk are never touched, so a crash mid-write
  can lose at most the row being appended.

### `src/caps.ts`

Spend caps: the constitution's money-approval thresholds as a pure
function. No filesystem, no network.

#### `interface SpendPolicy`

```ts
interface SpendPolicy {
  autoApproveUnder: number;
  notifyUnder: number;
  approvalCodeOver: number;
}
```

- `autoApproveUnder` — spend strictly below this proceeds with no owner
  involvement.
- `notifyUnder` — spend strictly below this (and at/above
  `autoApproveUnder`) notifies the owner but proceeds.
- `approvalCodeOver` — spend at/above this requires the owner's approval
  code before it proceeds.

Boundaries are inclusive on the stricter side: a spend exactly at a
threshold gets the more cautious outcome (e.g. exactly `approvalCodeOver`
needs approval, not just "notify").

#### `type SpendDecision`

```ts
type SpendDecision = "proceed" | "notify" | "needs-approval";
```

#### `DEFAULT_SPEND_POLICY: SpendPolicy`

```ts
const DEFAULT_SPEND_POLICY: SpendPolicy = {
  autoApproveUnder: 25,
  notifyUnder: 75,
  approvalCodeOver: 75,
};
```

The constitution's defaults: under $25 proceed, $25–75 notify, $75+ needs
the approval code.

#### `checkSpend(amountUsd: number, policy: SpendPolicy = DEFAULT_SPEND_POLICY): SpendDecision`

Classifies one spend under a policy:

```ts
if (amountUsd >= policy.approvalCodeOver) return "needs-approval";
if (amountUsd >= policy.autoApproveUnder || amountUsd >= policy.notifyUnder) return "notify";
return "proceed";
```

`approvalCodeOver` always wins if reached, even for a policy where
`notifyUnder` is set lower than `autoApproveUnder` — the approval-code
gate is the hard ceiling, not a suggestion. Under the default policy this
means: `< 25` → `"proceed"`; `25 <= amount < 75` → `"notify"`; `>= 75` →
`"needs-approval"`.

## Examples

### `appendLedger` + `readLedger` round-trip

```ts
import { appendLedger, readLedger } from "@mainspring/ledger";

const workspace = "./my-business";

await appendLedger(workspace, {
  date: "2026-07-01T00:00:00.000Z",
  type: "revenue",
  description: "pack sale",
  amountUsd: 24,
});

const row = await appendLedger(workspace, {
  date: "2026-07-02T00:00:00.000Z",
  type: "expense",
  description: "VPS",
  amountUsd: 20,
});

console.log(row.balanceUsd); // 4

const ledger = await readLedger(workspace);
console.log(ledger.balance()); // 4
console.log(ledger.entries.length); // 2
```

### `checkSpend` against a `SpendPolicy`

```ts
import { checkSpend, DEFAULT_SPEND_POLICY, type SpendPolicy } from "@mainspring/ledger";

checkSpend(24.99); // "proceed"   (< 25)
checkSpend(50);    // "notify"    (25 <= x < 75)
checkSpend(75);    // "needs-approval" (>= 75)

const tighter: SpendPolicy = { autoApproveUnder: 10, notifyUnder: 50, approvalCodeOver: 50 };
checkSpend(10, tighter); // "notify"
checkSpend(50, tighter); // "needs-approval"
```
