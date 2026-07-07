# @mainspring/example-full-stack-test

A runnable, offline proof that the whole Mainspring stack composes: **seven**
packages wired into one realistic multi-step session, no network, no
secrets, no API keys.

## What it demonstrates

`src/main.ts` hand-assembles a session loop (mirroring `examples/quickstart`,
extended with a relay hand-off and a pre-publish scrub gate) and runs a
scripted 6-step business day:

1. **Allowed.** The brain writes a landing-copy draft and notifies the
   owner. Governance finds nothing wrong; both actions are dispatched.
2. **Allowed spend.** A $15 hosting expense, safely under every cap.
3. **Blocked.** A $999 expense would blow the session's $50 cap — governance's
   `spend-caps` rule fires and blocks it by name.
4. **Blocked.** A write carrying a fake-but-secret-shaped Stripe key —
   governance's `no-secrets` rule fires and blocks it; it never touches disk.
5. **Relay hand-off.** The brain files a relay request for something only a
   human can do (clearing a CAPTCHA to create an account). `MockRelay` files
   it and a simulated human resolves it — the full file → resolve loop, no
   person and no network required.
6. **Sale + done.** A real $29 revenue entry lands, and the brain signals
   `done`.

After the loop, a **scrub pass** runs over an outbound draft that leaked a
fake AWS key: `scan()` finds it, `substitute()` redacts it, and the redacted
draft is proven safe by re-running it through the *same* governance
`no-secrets` guard that blocked step 4 — this time it passes, and the clean
draft is the one that actually gets written to disk.

Before any of that, an oversized `STATE.md` (8 days of session-log entries)
is compacted with `@mainspring/memory`'s `compactState()` down to a 40-line
budget, written to disk, and read back by `assemble()` as the first step's
context — proving memory's compaction, not just its journal/session-log
helpers, is exercised.

| Package | What it does here |
| --- | --- |
| `@mainspring/core` | `assemble()` builds `SessionInput` each turn; `applyAction()` dispatches writes/notifications |
| `@mainspring/brains` | `MockBrain` plays back the scripted 6-step `StepResult[]` — no model, no cost |
| `@mainspring/governance` | `loadConstitutionRules()` + `evaluate()` gate every proposed `Action`; blocks two of them by rule id |
| `@mainspring/ledger` | `appendLedger()`/`readLedger()` for the invariant-checked `LEDGER.csv`; `checkSpend()` cross-checked against the blocked/allowed amounts |
| `@mainspring/memory` | `compactState()` on `STATE.md`, `appendJournal()` per step, `appendSession()` at the end — the git-style session audit trail |
| `@mainspring/scrub` | `scan()`/`substitute()` — the pre-publish secret-redaction gate |
| `@mainspring/relay` | `MockRelay` — file → resolve a human-only blocker with zero network |

## Why this file, not `packages/core/test/integration.test.ts`

This lives under `examples/` (alongside `examples/quickstart`, which already
established the pattern) rather than inside `packages/core/test/` because
the whole point is composing *seven independent, cross-package* public
APIs — it isn't a core-package unit test, and core deliberately has zero
runtime dependencies on the packages it's being composed with here. An
`examples/*` package can depend on all seven via `workspace:*` without
making any of those seven depend on each other.

## A note on `core`'s own ledger dispatch

`@mainspring/core`'s `applyAction()` has a built-in `"ledger"` case that
hand-writes `LEDGER.csv` with its own header (`date,type,description,amount,
balance`) — a different schema than `@mainspring/ledger`'s canonical
`LEDGER_CSV_HEADER` (`date,type,description,amount_usd,balance_usd`).
`Ledger.fromCsv` checks the header exactly, so a file written by core's own
dispatch cannot be read back with `@mainspring/ledger`'s `readLedger()`.
Like `examples/quickstart`, this example avoids the seam entirely by never
routing `"ledger"` (or `"relay"`) actions through core's dispatch — it calls
`@mainspring/ledger`'s `appendLedger()` (and `@mainspring/relay`'s
`MockRelay`) directly instead, which is also the more correct integration:
those packages are the canonical, invariant-checked implementations. Worth a
follow-up order to either delete core's duplicate ledger/relay write paths
or fix the header to match.

## Run it

```sh
pnpm install
pnpm --filter @mainspring/example-full-stack-test start
```

`start` compiles and runs `src/main.ts`, which creates a fresh temp
workspace directory per run (via `mkdtemp`) and prints a readable trace of
every action, its governance verdict, the final ledger balance, the relay
outcome, and the scrub findings.

## Test it

```sh
pnpm --filter @mainspring/example-full-stack-test test
```

12 assertions covering all seven packages — see `test/full-stack.test.ts`.

---

One of several runnable, offline examples — see the
[examples index](../README.md) for the full map.
