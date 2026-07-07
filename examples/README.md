# Mainspring examples

Every example here is **runnable offline with zero credentials** — no network,
no API keys, no owner account. Each one is a real, asserting proof of one slice
of the loop, not a narrated screenshot. They're ordered simplest first.

Build the workspace once, then run any example:

```bash
pnpm install
pnpm -r build
```

| Example | Demonstrates | Run (from repo root) | Expected observable behavior |
|---|---|---|---|
| [`hello-business/`](hello-business) | The whole loop end to end through the `mainspring` **CLI**, using the zero-API-key [`EchoBrain`](../packages/core). No hand-assembly — this is what `mainspring init` scaffolds. | `cd examples/hello-business && node ../../packages/cli/dist/bin.js run` then `… status` | `run` prints `Session done in 1 step(s)` / `actions allowed: 3` / `spent this session: $0.00` and writes a journal heartbeat + one `$0` ledger line; `status` reports `Balance: $0.00 (1 ledger entry)`. |
| [`quickstart/`](quickstart) | The minimal five-package wiring ([`core`](../packages/core) + [`brains`](../packages/brains) + [`governance`](../packages/governance) + [`ledger`](../packages/ledger) + [`memory`](../packages/memory)): a scripted 3-step day where the `honesty-disclosure` rule blocks an undisclosed post. | `pnpm --filter @mainspring/example-quickstart start` | Prints a per-step trace: step 1 two `✓ ALLOWED` actions, step 2 `✗ BLOCK … honesty-disclosure`, step 3 ledger + `done`; final `Ledger balance: $0.00`. |
| [`content-agent/`](content-agent) | A different wiring from quickstart: a content business that gets blocked, routes the decision through the real [`@mainspring/relay`](../packages/relay) human-in-the-loop client (`MockRelay` + `EchoResponder`), then retries the now-disclosed publish. | `pnpm --filter @mainspring/example-content-agent start` | 5-step trace: block at step 2, `relay mock0001 done` at step 3, disclosed publish at step 4, `$-4.50` expense at step 5; final `Relay request: mock0001 (done)` / `Ledger balance: $-4.50`. |
| [`crash-resume/`](crash-resume) | The amnesia bet, isolated: session 1 does durable work then **crashes** mid-task; session 2 boots cold from disk ([`ledger`](../packages/ledger) + [`memory`](../packages/memory) only) and resumes from exactly where session 1 stopped — checking the ledger first so it never double-charges. | `pnpm --filter @mainspring/example-crash-resume start` | `SIMULATED CRASH` after `draft-intro`, then session 2 `resumed at exactly item "draft-features"`, finishes the rest, `done=true`, `ledger balance: $-1.65`. Deterministic (fixed timestamps). |
| [`full-stack-test/`](full-stack-test) | All **seven** packages composed into one realistic 6-step day, plus a pre-publish scrub gate ([`@mainspring/scrub`](../packages/scrub)) and `STATE.md` compaction ([`memory`](../packages/memory)). The widest integration proof. | `pnpm --filter @mainspring/example-full-stack-test start` | 6-step trace: `spend-caps` blocks an over-cap expense (step 3), `no-secrets` blocks a key-shaped write (step 4), relay hand-off resolves (step 5); final `Ledger balance: $14.00 across 2 entries` / `Scrub: 1 finding(s) before redaction, 0 after`. |

## Testing the examples

The four hand-assembled examples ship an asserting test suite (the CLI-driven
`hello-business` is covered by [`packages/cli`](../packages/cli)'s own tests
instead):

```bash
pnpm --filter @mainspring/example-quickstart      test
pnpm --filter @mainspring/example-content-agent   test
pnpm --filter @mainspring/example-crash-resume    test
pnpm --filter @mainspring/example-full-stack-test test
# or, all of them (and every package) at once:
pnpm -r test
```

Each `start`/`test` compiles first (`tsc`) and runs in a fresh `mkdtemp`
workspace, so a run never touches the repo or a previous run's state.

## Which one should I read first?

- **Just want to see it run?** → `hello-business` (it's the CLI path, and what
  `mainspring init` gives you).
- **Learning the package APIs?** → `quickstart`, then `content-agent` for the
  relay hand-off, then `full-stack-test` for the full composition.
- **Skeptical the amnesia story holds?** → `crash-resume` proves it by
  assertion across a hard process boundary.

See the [root README](../README.md) for the loop overview and
[`docs/`](../docs) for the architecture, the Brain contract, and deployment.
