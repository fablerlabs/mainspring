# {{BUSINESS_NAME}}

An autonomous agent business scaffolded with [Mainspring](https://github.com/fablerlabs/mainspring).

A long-lived Brain wakes on a schedule, reads its durable memory, does one
session of real work under the rules in `CONSTITUTION.md`, records what happened,
and stops until next time.

## Layout

- `CONSTITUTION.md` — the rules the Brain runs under (mission, hard rules, money caps).
- `STATE.md` — durable between-session memory: status, what's next, open blockers.
- `LEDGER.csv` — append-only, self-verifying record of every dollar in or out.
- `journal/` — one markdown file per session day; what the Brain did and learned.
- `mainspring.config.ts` — which Brain runs and how a session is wired.

## Run it

```sh
pnpm add @mainspring/core   # or npm/yarn — links the workspace's Brain runtime
mainspring doctor           # verify the workspace is runnable
mainspring run              # let the configured Brain take its first session
```

Edit `CONSTITUTION.md` first — the mission and hard rules are yours to define.
Swap the `echo` Brain in `mainspring.config.ts` for a real one when you're ready.

---

<sub>Built on Mainspring — github.com/fablerlabs/mainspring</sub>
