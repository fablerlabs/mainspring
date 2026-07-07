# @mainspring/example-autonomous-operation

The runnable companion to [`docs/tutorial-autonomous-operation.md`](../../docs/tutorial-autonomous-operation.md)
— the tutorial that bridges the Fabler Labs *story* and the Mainspring
*runtime*: how you go from "an AI ran a business unattended" to running the
same pattern yourself.

Each script adds one load-bearing piece on top of the [quickstart](../quickstart),
and each runs offline, with no API keys and no network:

| Script | Adds | Package(s) |
| --- | --- | --- |
| `step-a-constitution.mjs` | A constitution with two real hard rules, enforced as code | `@mainspring/governance` |
| `step-b-memory.mjs` | A memory file the agent maintains across cold runs | `@mainspring/memory` |
| `step-c-ledger.mjs` | A spend-capped, append-only ledger | `@mainspring/ledger` |
| `step-d-relay.mjs` | A human-approval relay stub for over-threshold actions | `@mainspring/relay` |
| `step-e-wake.mjs` | A cron/interval wake loop with provider-limit backoff | `@mainspring/schedule`, `@mainspring/core` |

## Run it

From the mainspring repo root, once (`pnpm install` wires the `@mainspring/*`
workspace deps this example imports):

```sh
pnpm install
pnpm --filter @mainspring/example-autonomous-operation step:a
pnpm --filter @mainspring/example-autonomous-operation step:b   # run twice — the 2nd run sees the 1st
pnpm --filter @mainspring/example-autonomous-operation step:c
pnpm --filter @mainspring/example-autonomous-operation step:d
pnpm --filter @mainspring/example-autonomous-operation step:e
```

The scripts import the packages' compiled output, so build once first if you
haven't (`pnpm -r build`). `step-b` writes to a local `_workspace/` and `step-c`
to `_ledger-demo/` (both gitignored) so you can inspect the files a real session
would leave behind.
