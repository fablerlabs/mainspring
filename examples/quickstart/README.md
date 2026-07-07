# @mainspring/example-quickstart

A runnable, offline proof that the Mainspring loop actually works: five
packages wired into one real session, no network, no secrets, no API keys.

## What it demonstrates

`src/main.ts` hand-assembles a session loop and runs a scripted 3-step
business day:

1. **Step 1 — allowed.** The brain writes a landing-copy draft and notifies
   the owner. Governance finds nothing wrong; both actions are dispatched to
   disk.
2. **Step 2 — blocked.** The brain attempts to post to Reddit without the
   required AI-disclosure flag. Governance's `honesty-disclosure` rule
   (constitution hard rule 2, "you are an AI and never claim otherwise")
   fires and blocks it — the action is refused with a named reason, not
   silently dropped.
3. **Step 3 — ledger + done.** A $0 `adjustment` ledger entry is appended
   and the brain signals `done`.

| Step | Package exercised | What it does |
| --- | --- | --- |
| all | `@mainspring/core` | `assemble()` builds the `SessionInput` each turn; `applyAction()` dispatches writes/notifications |
| all | `@mainspring/brains` | `MockBrain` plays back the scripted `StepResult`s — no model, no cost |
| all | `@mainspring/governance` | `loadConstitutionRules()` + `evaluate()` gate every proposed `Action` against `CONSTITUTION_MD` |
| 3 | `@mainspring/ledger` | `appendLedger()`/`readLedger()` — the invariant-checked `LEDGER.csv` |
| all | `@mainspring/memory` | `appendJournal()` after every step, `appendSession()` at the end |

## Run it

```sh
pnpm install
pnpm --filter @mainspring/example-quickstart start
```

`start` compiles and runs `src/main.ts`, which creates a fresh temp
workspace directory per run (via `mkdtemp`) and prints a readable trace of
every action, its governance verdict, and the final ledger balance.

## Test it

```sh
pnpm --filter @mainspring/example-quickstart test
```

Asserts: the allowed step-1 actions actually wrote to disk, the step-2
publish attempt was refused by name (`honesty-disclosure`) rather than just
absent, the ledger balance is exactly $0 with a single entry, and the
journal/session-log record all three steps.

---

One of several runnable, offline examples — see the
[examples index](../README.md) for the full map.
