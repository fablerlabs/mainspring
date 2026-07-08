# @mainspring/example-x402-buyer

A governed x402 buyer: an agent that proposes real micro-purchases, and
whose **spendGate** — built directly out of `@mainspring/governance`'s
`Rule`/`evaluate()` machinery, the same one that gates every other action in
Mainspring — decides which purchases are allowed to actually spend money.

## Why spend-governance matters for agent commerce

x402 (`HTTP 402 Payment Required`) lets an HTTP resource charge per request:
an agent GETs a URL, the server answers 402 with a price and payment
instructions, the agent pays, and retries to get the resource. It's a clean
protocol for machine-to-machine micro-payments — and also the most common
question about autonomous agents that spend money: **what stops a
compromised or just-wrong agent from paying for anything, in any amount, any
number of times?**

Libraries like `x402-fetch` collapse the whole exchange into one
auto-paying `fetch()` call, which is exactly the wrong shape for a governed
agent: the payment already happened before anything gets a chance to say no.
This example keeps the two legs of the exchange — `probe` (free: get the
402 challenge and its price) and `pay` (spends money) — as separate calls
(`X402Transport` in [`src/x402.ts`](src/x402.ts)), so a spendGate can sit
between them and veto a purchase *before* `pay()` is ever reached.

The spendGate itself ([`src/spendGate.ts`](src/spendGate.ts)) is two
ordinary `@mainspring/governance` `Rule`s:

- **`x402-per-action-cap`** — no single purchase may exceed a fixed ceiling,
  no matter how much budget remains today.
- **`x402-daily-cap`** — today's cumulative x402 spend (already-settled
  purchases plus this one) may not exceed a fixed daily ceiling.

Both compose with the built-in rules (`no-secrets`, `external-allowlist`,
...) via the same `evaluate()` every other Mainspring example uses. A
purchase that fires either rule is **blocked and cited by rule id** — the
trace says exactly which limit stopped it, not just "no."

## What it demonstrates

`src/main.ts` runs a 6-item shopping list (`PURCHASE_PLAN`) against a $2.00
per-action cap and a $5.00 daily cap, chosen so each block is caused by
exactly one rule — never both at once:

| # | URL | Price | Outcome |
| --- | --- | --- | --- |
| 1 | `eod-report` | $0.40 | **Allowed** — paid, running total $0.40 |
| 2 | `sentiment-snippet` | $0.35 | **Allowed** — paid, running total $0.75 |
| 3 | `full-history-dump` | $3.50 | **Blocked** by `x402-per-action-cap` ($3.50 > $2.00) — never paid. (Would've been $4.25 running, still under the $5.00 daily cap, so the daily-cap rule does *not* fire here — this block is per-action-only.) |
| 4 | `weekly-digest` | $1.80 | **Allowed** — paid, running total $2.55 |
| 5 | `macro-outlook` | $1.90 | **Allowed** — paid, running total $4.45 |
| 6 | `another-report` | $0.80 | **Blocked** by `x402-daily-cap` ($4.45 + $0.80 > $5.00), even though $0.80 alone is well under the $2.00 per-action cap — this block is daily-cap-only. |

Every allowed purchase calls `transport.pay()` and appends an `expense` row
to `LEDGER.csv` via `@mainspring/ledger`'s `appendLedger()` (invariant-
checked: each row carries the running balance). Every blocked purchase
touches neither — `transport.probe()` (the free GET) still runs so the agent
learns the price, but `transport.pay()` is never called and the ledger never
sees it.

## Run it

```sh
pnpm install
pnpm --filter @mainspring/example-x402-buyer start
```

Creates a fresh temp workspace (`mkdtemp`) and prints a readable trace: each
purchase's verdict, its price, and — for a blocked one — which rule fired
and why.

## Test it

```sh
pnpm --filter @mainspring/example-x402-buyer test
```

Asserts: the four in-budget purchases are allowed, paid (via the mock
transport), and recorded on the ledger in order with the correct amounts and
running balance; the over-per-action purchase is blocked *before* payment,
cited by `x402-per-action-cap` specifically (and *not* `x402-daily-cap` —
the day still has headroom left when it's evaluated); the
over-daily-remaining purchase is blocked and cited by `x402-daily-cap`
specifically (and *not* `x402-per-action-cap`), even though it's
individually well within the per-action cap; blocked purchases never call
`transport.pay()` and never reach the ledger; and the daily cap is genuinely
stateful across the loop (repeating the same $1.90 purchase three times
against the $5.00 cap allows the first two and blocks the third, once the
running total would cross the cap).

## Swapping in a real x402 client

`X402Transport` (in `src/x402.ts`) is the only seam a real implementation
needs to fill:

```ts
export interface X402Transport {
  probe(url: string): Promise<X402Challenge>; // free: GET, read the 402 challenge
  pay(challenge: X402Challenge): Promise<X402Receipt>; // spends money: retry with payment proof
}
```

A production version would wrap a real HTTP client (or the lower-level
primitives underneath `x402-fetch`, called directly rather than through its
auto-paying `fetch()` wrapper) to implement `probe`/`pay` against a live
x402 resource server and a real wallet. Nothing in `main.ts` or
`spendGate.ts` changes — they only ever see the `X402Transport` interface
and the `Action`/`Rule` vocabulary from `@mainspring/governance`.

## Integration note

This example has no dependency on `@mainspring/core` — `buy` isn't (yet) one
of core's `Action` kinds, so this loop models a purchase as a `run` action
naming the `x402-buy` tool with `{ url, priceUsd }` args, which fits
`@mainspring/governance`'s structural `Action` type without any change to
`packages/core` or `packages/governance`. If a future work order wants `buy`
promoted to a first-class core `Action` kind, `spendGate.ts`'s two `Rule`s
port over unchanged — only the `action.tool === "x402-buy"` guard in
`extractPriceUsd` would need to become `action.kind === "buy"`.
