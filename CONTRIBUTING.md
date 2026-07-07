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
packages/core/        the Brain contract + the constitution-enforcing session loop
packages/memory/      STATE.md / journal / session-log compaction utilities
packages/scrub/       the secret-shaped-string gate used before any publish/notify
packages/relay/       zero-dependency client for the Fabler Relay human-in-the-loop protocol
packages/ledger/      append-only LEDGER.csv + the Constitution's money-approval thresholds
packages/governance/  Constitution-as-code: hard rules loaded from CONSTITUTION.md
packages/brains/      reference Brain implementations (MockBrain, ClaudeBrain)
packages/broker/      capability-scoped tool dispatch with allowlists and spend/call caps
packages/schedule/    cadence/backoff/STOP-file checks for when a session should run at all
packages/cli/         the `mainspring` bin: init / run / status / doctor
examples/              runnable workspaces (hello-business, quickstart, content-agent, full-stack-test)
templates/default/     what `mainspring init` scaffolds into a new workspace
```

Each package under `packages/*` builds independently with its own
`tsconfig.json` (extending the shared `tsconfig.base.json`) and, where it
has tests, compiles them separately via `tsconfig.test.json` into
`dist-test/` before running them with the built-in Node test runner
(`node --test`) — no external test framework dependency. See
`docs/architecture.md` for the module map and trust-boundary rationale
behind the package split, and `README.md`'s package table for what's
shipped vs. still wired in only per-workspace.

## Code style

There's no linter or formatter configured (no ESLint/Prettier config in
the repo) — match the conventions already in the file you're editing.
The patterns below are what's actually consistent across `packages/*/src`
today:

- **Strict TypeScript, zero runtime dependencies.** Every `tsconfig.json`
  extends `tsconfig.base.json` (`strict: true`, ES2022, NodeNext modules).
  Every package's `dependencies` is `{}` except `@mainspring/broker` and
  `@mainspring/cli`, which depend only on other `@mainspring/*` workspace
  packages — never a third-party npm package. If your change needs one,
  say why in the PR description; it's a high bar here by design.
- **NodeNext ESM means explicit `.js` extensions.** Relative imports in
  `.ts` source and tests use a `.js` suffix (e.g. `from "../src/index.js"`)
  even though the file on disk is `.ts` — this is required by
  `moduleResolution: "NodeNext"`, not a typo.
- **Named exports only.** No `export default` appears anywhere in
  `packages/*/src` (the one exception, in `packages/cli`, is generated
  code expecting a *user's* `mainspring.config.ts` to have a default
  export — that's a workspace convention, not this repo's).
- **Error messages are prefixed with the throwing class/function** (e.g.
  `"ClaudeBrain: Anthropic API returned ..."`, `"capability already
  registered: ..."`) and never interpolate secrets — see `packages/scrub`
  if you're ever tempted to log a raw value that might be one.
- **JSDoc on every exported function/type**, focused on invariants and
  *why*, not restating the signature — e.g. `packages/ledger/src/caps.ts`'s
  boundary-inclusivity comment. Match that density on new public APIs.
- **Tests use only `node:test` + `node:assert/strict`**, colocated in each
  package's `test/` directory, compiled via that package's
  `tsconfig.test.json` into `dist-test/` before running (see `pnpm test`
  in any `packages/*/package.json`).

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
