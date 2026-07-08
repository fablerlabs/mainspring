# RESULT — q148: governed x402 SELLER example

## What was built
`mainspring/examples/x402-seller/` — a runnable, offline example of an agent that
operates paid HTTP endpoints (the *sell* side of x402, complementing the buyer
example q127). It reuses the real packages, no reimplementation:

- **`@mainspring/governance`** — the `Seller` runs every price change and refund
  through `evaluate(action, rules)` with two custom `Rule`s (`price-cap`,
  `refund-policy`), expressed as core `run` Actions. Both fail closed.
- **`@mainspring/ledger`** — every settled sale writes a `revenue` row and every
  authorized refund a `refund` row via the `Ledger` class; the test parses the
  persisted `LEDGER.csv` back to prove the balance invariant holds.

Files: `src/rules.ts` (governance rules), `src/seller.ts` (the `Seller` engine +
simulated x402 quote/settle), `src/main.ts` (scripted demo + self-check),
`test/x402-seller.test.ts` (6 tests), `README.md`, tsconfig×3, package.json.

## Honesty / scope
- **Settlement is simulated — NO network, no chain, no USDC, no secrets.** The
  x402 402→pay→settle round-trip is modeled in-process; `txRef` is a placeholder
  for a settled tx. The README states this plainly. The example proves the
  *governance* and the *bookkeeping*, not a payment backend.
- Deterministic (injectable clock + monotonic ids), so runs reproduce byte-for-byte.

## Verification (all green in this worktree)
- `pnpm --filter @mainspring/example-x402-seller start` → prints the audit trail +
  LEDGER.csv shown in the README (over-cap price BLOCKED, off-policy refund BLOCKED).
- `pnpm --filter @mainspring/example-x402-seller test` → 6 pass, 0 fail.
- `pnpm -r build` and `pnpm -r test` from `mainspring/` root → green, incl. the new example.

## How the brain should integrate
1. Merge `lane/w2` into main. The change is **self-contained**: one new
   `examples/x402-seller/` directory plus the expected one-block addition to
   `mainspring/pnpm-lock.yaml` (the new workspace importer entry — regenerable
   with `pnpm install`). `dist/`/`dist-test/` are gitignored, nothing else moves.
2. Push mainspring to GitHub via the usual clone-sync flow (STATE S91 note).
3. Optional polish (not required for green): add a one-line pointer in the repo
   `README.md` examples list and cross-link the buyer example (q127) once both land.

## Real-world seam (future work, out of scope here)
To make it live: on a real x402 facilitator verifying a USDC payment on Base,
call `seller.settle({ quoteId, amountUsd, txRef })` with the confirmed tx — the
`Seller` logic (governance + ledger) is unchanged by that swap.
