# Contributing to Mainspring

Thanks for taking a look. Mainspring is a young (v0.1) project — the loop,
gate, dispatch, CLI, and `EchoBrain` are real and tested, but there's a lot
of the roadmap left open (see `docs/architecture.md` → "Known v0.1 gaps").
Bug reports, first-party model adapters, and doc fixes are all welcome.

## This is an AI-maintained repo

This repo is maintained by [Fabler Labs](https://fablerlabs.com), whose
day-to-day maintainer is an autonomous AI agent operating under its own
constitution — the same pattern Mainspring generalizes. In practice:

- Issues and PRs are triaged by the agent during its periodic sessions, not
  continuously. Expect a first response within a few days, not hours.
- Anything that touches money, credentials, or an external account is
  routed to a human (the repo owner) before it's acted on — the agent will
  say so plainly if that's what's happening on your issue/PR.
- The agent will always disclose that it's an AI if asked. It never
  fabricates human attestation, sockpuppets, or fake reviews — if you see
  anything that looks like that, please report it as a bug in the process,
  not just the code.

None of this changes how a normal open-source contribution works — it just
sets expectations on turnaround time and who's on the other end.

## Dev setup

Mainspring is a pnpm workspace. You need Node.js 20+ and pnpm (via
[Corepack](https://nodejs.org/api/corepack.html), enabled with the version
pinned in the root `package.json`'s `packageManager` field):

```sh
corepack enable
pnpm install
pnpm -r build   # tsc --build across every package
pnpm -r test    # node --test across every package with tests
```

Run a single package's scripts from its directory (e.g. `cd packages/core
&& pnpm build && pnpm test`), or use pnpm's filter flag from the repo root:
`pnpm --filter @mainspring/core test`.

## How the packages are laid out

```
packages/core/     the Brain contract + the constitution-enforcing session loop
packages/memory/   STATE.md / journal / session-log compaction utilities
packages/scrub/    the secret-shaped-string gate used before any publish/notify
packages/relay/    zero-dependency client for the Fabler Relay human-in-the-loop protocol
packages/cli/      the `mainspring` bin: init / run / status / doctor
examples/hello-business/  a runnable workspace using the zero-API-key EchoBrain
templates/default/        what `mainspring init` scaffolds into a new workspace
```

Each package under `packages/*` builds independently with its own
`tsconfig.json` (extending the shared `tsconfig.base.json`) and, where it
has tests, compiles them separately via `tsconfig.test.json` into
`dist-test/` before running them with the built-in Node test runner
(`node --test`) — no external test framework dependency. See
`docs/architecture.md` for the module map and trust-boundary rationale
behind the package split.

## Before you open a PR

- `pnpm -r build && pnpm -r test` must pass locally — this is exactly what
  CI runs (`.github/workflows/ci.yml`), across Node 20 and 22.
- Keep changes scoped to one package where possible; cross-package changes
  should explain why in the PR description.
- No secrets, tokens, or real credentials in any commit, fixture, or test —
  this repo is scrubbed before every publish (see `docs/publishing.md`) but
  don't rely on that as a safety net.

## License and contributor terms

Mainspring is licensed under [Apache-2.0](LICENSE). By submitting a PR you
agree your contribution is offered under that same license — there's no
separate CLA and no DCO sign-off required. If your employer or another
party holds rights to your contribution, please make sure you're clear to
submit it under Apache-2.0 before opening the PR.

## Reporting bugs / proposing ideas

Use the issue templates: `.github/ISSUE_TEMPLATE/bug.yml` for something
broken, `.github/ISSUE_TEMPLATE/idea.yml` for a proposal or feature
request. For anything that looks like a security issue, please say so in
the title so it gets triaged first.
