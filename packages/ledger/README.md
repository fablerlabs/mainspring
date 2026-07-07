# @mainspring/ledger

The money module: append-only `LEDGER.csv` management with balance
invariants and spend-cap thresholds — the constitution's Money rules as
code. Zero runtime dependencies, no LLM calls, no network.

## Install

```sh
npm install @mainspring/ledger
```

## Usage

```ts
import { appendLedger, checkSpend } from "@mainspring/ledger";

const decision = checkSpend(30); // "proceed" | "notify" | "needs-approval"

const row = await appendLedger("./my-business", {
  date: new Date().toISOString(),
  type: "expense",
  description: "domain renewal",
  amountUsd: 12,
});

console.log(row.balanceUsd);
```

`appendLedger` only ever appends new bytes to `LEDGER.csv` — it never
rewrites earlier rows, so a corrupted or hand-edited row is caught by the
balance invariant instead of loading silently.
