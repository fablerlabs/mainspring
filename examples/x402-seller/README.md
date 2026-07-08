# x402-Seller Example

A runnable proof of a **governed x402 seller**: an agent operates two paid HTTP
endpoints, settles agent payments, and books every sale — while Mainspring's
**governance** decides what the operator may and may not change. Offline, zero
credentials, no real money, no chain.

This is the sell side of agent commerce. (The buy side — an agent that *pays* for
a paid endpoint under a spend cap — is the `x402-buyer` example.)

## What it shows

The scripted operator runs one session:

| Step | Operation | Outcome |
| ---- | --------- | ------- |
| 1 | Sell 5 endpoint calls (quote → settle) | **SETTLED** → each writes revenue to `LEDGER.csv` |
| 2 | Raise `/summarize` to **$0.50** (cap is $0.10) | **BLOCKED** by the `price-cap` rule; price untouched |
| 3 | Raise `/summarize` to **$0.05** (within cap) | **ALLOWED** |
| 4 | Refund a sale for `"changed-my-mind"` | **BLOCKED** by the `refund-policy` rule; nothing hits the ledger |
| 5 | Refund that same sale for `"service-unavailable"` (a policy reason) | **ALLOWED** → writes a refund row |

### The x402 settle flow (simulated — no network)

Each sale is a faithful but **offline** x402 round-trip:

1. A request to a paid route returns an **HTTP 402** quote:
   `{ status: 402, route, amountUsd, asset: "USDC", network: "base", quoteId }`.
2. The buyer "pays" and re-presents a **payment proof** (`{ quoteId, amountUsd, txRef }`).
   `txRef` stands in for a settled on-chain tx — **there is no chain and no network here.**
3. The seller verifies the proof against the quote it issued (amount must match;
   a quote is single-use, so a real payment can't be replayed), records revenue
   in [`@mainspring/ledger`](../../packages/ledger), and returns a 200 receipt.

**Settlement is simulated.** This example proves the *governance* and the
*bookkeeping*, not a payment backend. Wiring a real x402 facilitator (verify a
USDC payment on Base, then call `seller.settle(...)`) is the integration seam —
the seller logic above is unchanged by it.

## How governance is wired

The two enforced policies are ordinary [`@mainspring/governance`](../../packages/governance)
`Rule`s — the same shape, `Verdict` vocabulary, and `evaluate()` precedence the
core runtime uses. Seller operations are expressed as core `run` Actions so they
flow through governance unchanged:

```ts
// A price change and a refund, as governed Actions:
{ kind: "run", tool: "set-price", args: { route, newPriceUsd } }   // → price-cap rule
{ kind: "run", tool: "refund",    args: { saleId, reason, ... } }  // → refund-policy rule
```

Both rules **fail closed**: a malformed price (non-finite, negative) or a
missing/off-policy refund reason is blocked, never waved through. A sale, by
contrast, is the ordinary allowed path — its price can never exceed the cap
because `setPrice` is what governance guards.

## Run it

```bash
pnpm --filter @mainspring/example-x402-seller start
```

Expected output (workspace path varies):

```
Audit trail (settle / price change / refund):
  ✓ ALLOWED  settle       $0.02  /summarize
             settled sale-0002
  ✓ ALLOWED  settle       $0.02  /summarize
             settled sale-0004
  ✓ ALLOWED  settle       $0.02  /summarize
             settled sale-0006
  ✓ ALLOWED  settle       $0.01  /classify
             settled sale-0008
  ✓ ALLOWED  settle       $0.01  /classify
             settled sale-0010
  ✗ BLOCKED  set-price    $0.50  /summarize
             An endpoint's price may not exceed the $0.10 cap.
  ✓ ALLOWED  set-price    $0.05  /summarize
             price for /summarize set to $0.05
  ✗ BLOCKED  refund       $0.02  sale-0002
             A refund may only be issued for a reason named in the refund policy.
  ✓ ALLOWED  refund       $0.02  sale-0002
             refunded sale-0002 ($0.02): service-unavailable

Net revenue (after refunds): $0.06

LEDGER.csv:
date,type,description,amount_usd,balance_usd
2026-07-08T00:00:00.000Z,revenue,x402 /summarize (sale-0002),0.02,0.02
2026-07-08T00:00:00.000Z,revenue,x402 /summarize (sale-0004),0.02,0.04
2026-07-08T00:00:00.000Z,revenue,x402 /summarize (sale-0006),0.02,0.06
2026-07-08T00:00:00.000Z,revenue,x402 /classify (sale-0008),0.01,0.07
2026-07-08T00:00:00.000Z,revenue,x402 /classify (sale-0010),0.01,0.08
2026-07-08T00:00:00.000Z,refund,refund sale-0002: service-unavailable,0.02,0.06
```

## Test it

```bash
pnpm --filter @mainspring/example-x402-seller test
```

## Wiring, in a few lines

```ts
import { Seller } from "./seller.js";

const seller = new Seller({
  endpoints: [{ route: "/summarize", priceUsd: 0.02 }],
  policy: { maxPriceUsd: 0.1, refundReasons: ["duplicate-charge", "service-unavailable"] },
});

const quote = seller.quote("/summarize");                       // HTTP 402
const receipt = seller.settle({ quoteId: quote.quoteId,         // simulated pay → ledger revenue
                                amountUsd: quote.amountUsd, txRef: "0x…" });

seller.setPrice("/summarize", 0.5);   // → { allowed: false, reason: "…cap…" }   (governance blocks)
seller.refund(receipt.saleId, "x");   // → { allowed: false, reason: "…policy…" } (governance blocks)
```

Every settle and every governed decision is recorded in `seller.audit`; the full
ledger is `seller.ledgerCsv()` (valid per `@mainspring/ledger`'s balance
invariant — the test parses it back to prove it).
