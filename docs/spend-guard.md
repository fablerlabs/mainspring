# The Spend Guard

Mainspring already enforces one money rule structurally: `gate.ts` rejects any
`expense` whose amount would push a session past its constitution's **hard**
per-session ceiling (`moneyCaps.perSessionUsd`). That is a single ceiling — over
it is blocked, under it is allowed.

The **spend guard** adds the *tiered* rule the constitution's Money section
actually spells out — under a threshold proceed, in a middle band notify the
owner, past a ceiling require the owner's approval code — and it makes those
tiers something the **runtime enforces**, not merely something a Brain is asked
to respect. It is the first slice of roadmap v0.3's "broker for capped spending":
the caps live in the loop, not in the model.

It lives in [`packages/core/src/spendGate.ts`](../packages/core/src/spendGate.ts)
and reuses [`@mainspring/ledger`](../packages/ledger)'s `checkSpend` for the band
classification, so there is exactly one definition of the thresholds.

## What is enforced

When you pass a `spendPolicy` to `runSession`, every Action the Constitution gate
has already allowed is run through the spend guard **before dispatch**:

- An Action that moves money out — an `expense` ledger line, or a `run` Action
  whose args carry an `amountUsd` (a "spend tool") — is classified by
  `checkSpend` into one of three tiers:
  - **proceed** (under `autoApproveUnder`): dispatched, written to the ledger.
  - **notify** (`autoApproveUnder`–`approvalCodeOver`): dispatched, and the
    session records that the owner is owed a heads-up.
  - **needs-approval** (at/above `approvalCodeOver`): **BLOCKED** and never
    dispatched — unless `approvalCodePresent: true` was passed (i.e. the owner
    actually supplied the approval code this session).
- The guard **fails closed.** A spend whose amount is missing, non-numeric,
  `NaN`, `Infinity`, or negative is blocked outright, never waved through as
  "proceed". This mirrors `gate.ts`'s structural fail-closed checks.
- Every spend attempt — allow, notify, or deny — appends one entry to an audit
  trail shaped like `@mainspring/broker`'s (`timestamp`, `capability`, `op`,
  `amountUsd`, `allowed`, `reason`, `decision`). The loop persists it to
  `.mainspring/last-session.json` under `spendAudit`.

Bands are inclusive on the stricter side (exactly `approvalCodeOver` needs
approval, not just "notify") — money code never rounds in its own favor.

## What is NOT enforced (honest limits)

- **It gates Actions routed through the loop, not arbitrary code.** The guard
  only sees what a Brain proposes as an Action and what `runSession` dispatches.
  A tool handler that goes off and spends money by some path the loop never
  classified as a spend is outside this boundary — the boundary is the Action
  vocabulary, same as the rest of the gate.
- **It authorizes; it does not pay.** Like the broker, the guard decides
  allow/deny; a real payment rail is a handler wired in behind it. Nothing here
  touches a card, a bank, or the network.
- **It is opt-in and additive.** Omit `spendPolicy` and the loop behaves exactly
  as before. The hard per-session cap in `gate.ts` still applies either way; the
  spend guard is a finer second layer *on top of* it, not a replacement.
- **`approvalCodePresent` is trust the caller asserts.** The guard does not
  itself validate an owner approval code — the wiring code that sets that flag
  is responsible for confirming a valid code was actually received.

## Wiring

```ts
import { runSession } from "@mainspring/core";
import { DEFAULT_SPEND_POLICY } from "@mainspring/ledger";

await runSession({
  workspaceDir,
  constitution,
  brain,
  // Opt in to the policy-tier spend guard. Defaults to the constitution's
  // bands: under $25 proceed, $25–75 notify, $75+ needs the approval code.
  spendPolicy: DEFAULT_SPEND_POLICY,
  // Set true ONLY when the owner's approval code was actually received.
  approvalCodePresent: false,
});
```

You can also use the guard directly, outside the loop:

```ts
import { SpendGate } from "@mainspring/core";

const guard = new SpendGate({ policy: DEFAULT_SPEND_POLICY });
const decision = guard.check(someAction); // { status: "allow" | "notify" | "block", ... }
console.log(guard.audit); // the full spend audit trail
```

See the runnable [`examples/spend-guard`](../examples/spend-guard) for an
end-to-end session where a $5 spend is allowed and a $500 spend is blocked by
the runtime.
