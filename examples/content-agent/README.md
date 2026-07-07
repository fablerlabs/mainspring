# @mainspring/example-content-agent

A second runnable example, distinct from
[quickstart](../quickstart): a content-business agent that drafts a post,
gets a publish attempt blocked for missing the required AI-disclosure flag,
hands the decision to a human over a relay, and only then publishes — on a
shoestring budget. Proves Mainspring generalizes beyond one toy wiring.

## What it demonstrates

`src/main.ts` hand-assembles a session loop and runs a scripted 5-step
content-business day:

1. **Step 1 — allowed.** The brain drafts a post and notifies the owner.
   Governance finds nothing wrong; both actions are dispatched to disk.
2. **Step 2 — blocked.** The brain attempts to publish the post without the
   AI-disclosure flag. Governance's `honesty-disclosure` rule (constitution
   hard rule 2, "you are an AI and never claim otherwise") fires and blocks
   it — refused by name, not silently dropped.
3. **Step 3 — human-in-the-loop.** The brain files a relay request asking a
   person to approve the disclosed publish. A `MockRelay` + `EchoResponder`
   stand in for the human: the request is filed, "approved", and the loop
   waits on it via `pollUntilResolved` — the same primitive a real deployment
   polls against the live Fabler Relay.
4. **Step 4 — allowed.** The brain retries the exact same publish, now with
   `disclosedAsAI: true`. Governance allows it; the post (with its
   AI-disclosure footer) is written to `outbox/published/`.
5. **Step 5 — ledger + done.** A small `$4.50` expense (comfortably inside
   the tiny `$15` per-session cap) is appended to the ledger and the brain
   signals `done`.

| Step | Package exercised | What it does |
| --- | --- | --- |
| all | `@mainspring/core` | `assemble()` builds the `SessionInput` each turn; `applyAction()` dispatches writes/notifications/runs |
| all | `@mainspring/brains` | `MockBrain` plays back the scripted `StepResult`s — no model, no cost |
| all | `@mainspring/governance` | `loadConstitutionRules()` + `evaluate()` gate every proposed `Action`; `honesty-disclosure` blocks step 2 by name |
| 3 | `@mainspring/relay` | `MockRelay.fileRequest()` files the approval; `EchoResponder` stands in for the human; `pollUntilResolved()` waits for the terminal `done` |
| 5 | `@mainspring/ledger` | `appendLedger()`/`readLedger()` — the invariant-checked, tiny-budget `LEDGER.csv` |
| all | `@mainspring/memory` | `appendJournal()` after every step, `appendSession()` at the end |

Unlike quickstart's `relay` action (core's built-in dispatch just writes a
JSON file to `relay/pending/`), this example routes the `relay` Action
through the real `@mainspring/relay` package — the same client surface a
production workspace would poll against a live Fabler Relay deployment.

## Run it

```sh
pnpm install
pnpm --filter @mainspring/example-content-agent start
```

`start` compiles and runs `src/main.ts`, which creates a fresh temp
workspace directory per run (via `mkdtemp`) and prints a readable trace of
every action, its governance verdict, the relay request's id/status, and
the final ledger balance.

## Test it

```sh
pnpm --filter @mainspring/example-content-agent test
```

Asserts: the step-1 draft and notification actually wrote to disk, the
step-2 publish attempt was refused by name (`honesty-disclosure`) rather
than just absent, the step-3 relay request was filed and resolved `done` by
a human before anything proceeded, the step-4 disclosed publish landed on
disk with its AI-disclosure footer, the ledger balance is exactly `-$4.50`
with a single expense entry, and the journal/session-log record all five
steps.
