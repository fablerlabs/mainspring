# Spend-Guard Example

A runnable proof that Mainspring's **runtime** — not the brain, not the calling
code — enforces the constitution's spend tiers. Offline, zero credentials, no
real money.

A scripted agent proposes two spends in one session:

| Spend | Amount | Tier (default policy) | Outcome |
| ----- | ------ | --------------------- | ------- |
| analytics tool subscription | **$5** | under `autoApproveUnder` ($25) | **PROCEEDS** → written to `LEDGER.csv` |
| Reddit ad buy | **$500** | at/above `approvalCodeOver` ($75) | **BLOCKED** by the runtime, cited in the audit trail |

The constitution's *hard* per-session ceiling (`moneyCaps.perSessionUsd`) is set
high on purpose, so it is the finer **policy-tier spend gate** — wired in via
`runSession({ spendPolicy })` — that blocks the $500, not the hard cap. That
gate reuses `@mainspring/ledger`'s `checkSpend` for its thresholds and records
every attempt (allow or deny) in a broker-style audit trail, persisted to
`.mainspring/last-session.json`.

## Run it

```bash
pnpm --filter @mainspring/example-spend-guard start
```

Expected output (workspace path varies):

```
  ✓ ALLOWED  $5.00  analytics-tool-subscription
             spend of $5 is under the auto-approve threshold ($25); proceeds
  ✗ BLOCKED  $500.00  reddit-ad-buy
             spend of $500 needs the owner's approval code (>= $75) and none is present; BLOCKED fail-closed

Spent this session: $5.00 (only the allowed spend)
Actions blocked:    1

LEDGER.csv:
date,type,description,amount,balance
...,expense,analytics-tool-subscription,5.00,-5.00
```

## Test it

```bash
pnpm --filter @mainspring/example-spend-guard test
```

## Wiring, in one line

```ts
await runSession({ workspaceDir, constitution, brain, spendPolicy: DEFAULT_SPEND_POLICY });
```

Omit `spendPolicy` and the loop behaves exactly as before — the hard per-session
cap still applies; the spend gate is an opt-in second layer on top of it. Pass
`approvalCodePresent: true` (only when the owner's approval code is actually
present) to let a needs-approval spend proceed.

See [`docs/spend-guard.md`](../../docs/spend-guard.md) for what is and isn't
enforced.
