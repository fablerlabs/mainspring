# Roadmap

An honest map of what Mainspring is today and where it's going. No dates, no
vaporware — items move forward only when the code on `main` supports them. If
something here is marked done, it is real and tested; if it's planned, it
isn't built yet. This file is refreshed against the actual package contents
and `CHANGELOG.md`, not against intent.

The organizing principle never changes: **the Brain proposes, the
Constitution-checked loop disposes.** Every version below preserves the trust
boundary in [architecture.md](./architecture.md) — new capability is added
*around* `assemble → gate → dispatch → commit`, never by letting a Brain skip
it.

## Shipped

**The reference loop (`packages/core`, `packages/cli`)** — the only path that
is both tested *and* wired end to end today:

- **The loop** — `runSession` in `loop.ts`: assemble → `brain.step()` → gate →
  dispatch → `git commit`, with a `maxSteps` safety valve.
- **The gate** — `gate.ts`: money caps enforced structurally (per-session
  spend ceiling), workspace-path safety, `.env`/`.git` write protection,
  fail-closed Action validation, and secret-shaped-content blocking on
  `write`/`notify`. Covered by `packages/core/test/gate.test.ts`.
- **Dispatch** — `dispatch.ts`: the only filesystem writer; applies `write`,
  `ledger` (with running-balance computation), `enqueue`, `relay`, `notify`,
  and `done`.
- **`EchoBrain`** — a deterministic, zero-API-key reference Brain that proves
  the loop end to end with no network and no credentials.
- **CLI** — `mainspring init | run | status | doctor`, verified against a
  real scaffolded workspace.
- **The Brain contract** — the `Brain` / `Action` / `SessionInput` types and
  the [writing-a-brain guide](./brains.md).

**Standalone packages** — each is real, has its own passing test suite, and
builds clean under `tsc --strict`. None of them are stubs. What they don't
yet have is a call site inside the reference loop above — see "Wiring gaps"
below for exactly what that means package by package.

- **`@mainspring/memory`** (`packages/memory`) — deterministic `STATE.md`
  compaction, journal, and session-log utilities for the amnesiac session
  loop. Exercised end to end (including compaction, not just journaling) in
  `examples/full-stack-test`.
- **`@mainspring/scrub`** (`packages/scrub`) — a secret-shaped-string scan
  gate for anything a business publishes to the outside world. Exercised in
  `examples/full-stack-test` (redacts a leaked key, then re-validates the
  redacted draft against governance's `no-secrets` rule).
- **`@mainspring/relay`** (`packages/relay`) — a zero-dependency client (plus
  `MockRelay`) for the Fabler Relay human-in-the-loop wire protocol.
- **`@mainspring/ledger`** (`packages/ledger`) — append-only `LEDGER.csv`
  management with balance invariants and spend-cap thresholds.
- **`@mainspring/governance`** (`packages/governance`) — constitution-as-code:
  `loadConstitutionRules()` parses a `CONSTITUTION.md`'s "## Hard rules"
  section into built-in `Action` guards (money caps, no-secrets, workspace
  safety, ...), with an adversarial test suite (`test/adversarial.test.ts`).
- **`@mainspring/brains`** (`packages/brains`) — reference `Brain`
  implementations: a scripted `MockBrain` for tests, and `ClaudeBrain`, a
  zero-SDK adapter that maps the Anthropic Messages API's tool-use protocol
  to `Action`s via `fetch`. Request/response mapping is unit-tested against
  fixtures; see "Wiring gaps" for what isn't yet proven.
- **`@mainspring/broker`** (`packages/broker`) — capability-gated side
  effects: a `Broker` registers named `Capability`s (spend, message,
  publish, ...), each with a `Cap` (max amount, max calls/day, optional
  target allowlist), and every `request()` is checked against that cap
  *before* its handler runs, with one audit entry either way. Generalizes
  the credential-broker spec the autonomous agent behind this repo runs
  under into a model-agnostic library. Ships `memoryBroker.ts`, a worked `spend`
  capability against an in-memory `@mainspring/ledger` `Ledger`, as the
  pattern for wiring in a real rail (Stripe, Telegram, a publish endpoint).
  13/13 tests passing.
- **`@mainspring/schedule`** (`packages/schedule`) — pure, dependency-free
  logic for "should a session run now, and with what focus?": `decide()`
  checks a STOP file, a fixed interval or five-field UTC cron subset, and an
  exponential-backoff state, with no OS timers, clock reads, or filesystem
  access of its own — the caller supplies `now` and prior state. Designed to
  be driven by cron, systemd, CI, or a bare loop. 20/20 tests passing.

**`examples/full-stack-test`** is the closest thing to an integration proof
today: a hand-assembled 6-step session (`src/main.ts`) that wires `core` +
`brains` + `governance` + `ledger` + `memory` + `scrub` + `relay` together —
an allowed write+notify, an allowed spend, a spend-cap block, a secret block,
a relay file→resolve round trip, and a revenue entry, all offline. It proves
the packages *compose*; it does not prove `mainspring run` calls them itself
(see below), because `main.ts` builds its own loop around `governance` and
`ledger` rather than using `core`'s built-in `gate.ts` / `dispatch.ts`.

## In progress — wiring gaps

Every item here is the same shape: a package above is done and tested in
isolation, but `packages/core`'s reference loop still has its own inline,
duplicate logic instead of calling it. Closing these is what "v0.2" means —
no new packages, just plumbing.

- **Governance-in-gate seam.** `gate.ts` hard-codes its own money-cap check,
  its own forbidden-path list, and its own secret-pattern regexes. All of
  that logic already exists, tested, in `@mainspring/governance`
  (`createBuiltInRules` / `evaluate` / `loadConstitutionRules`). The gate
  needs to call governance instead of re-implementing it, so a
  `CONSTITUTION.md`'s "## Hard rules" section is the single source of truth
  for both.
- **Dispatch-broker seam — shipped, opt-in.** `dispatch.ts` now accepts an
  optional injected `Broker` (structurally typed as `BrokerLike`, wired
  through `runSession({ broker })`): when present, every money-moving/external
  Action (`expense` ledger lines, `run`, `notify`, `relay`) is authorized and
  audited by `@mainspring/broker` before any workspace effect, failing closed
  on anything unregistered or over cap. What remains: nothing constructs and
  injects a `Broker` by default — a workspace opts in by registering its own
  capabilities and passing the instance to `runSession`.
- **Brains live-path.** `ClaudeBrain`'s request/response mapping is
  unit-tested against fixtures, but the actual `fetch` call against
  `https://api.anthropic.com` is unverified end to end — no test in this repo
  makes a live call (correctly: no `ANTHROPIC_API_KEY` lives in CI). Whoever
  wires a real workspace to `ClaudeBrain` is currently the first person to
  prove the live path.
- **Schedule isn't called by anything.** `@mainspring/schedule`'s `decide()`
  is pure and tested, but `mainspring run` (`packages/cli/src/commands/run.ts`)
  runs a session unconditionally — no STOP check, no cadence, no backoff.
  There is no cron/systemd/loop host anywhere in this repo that calls
  `decide()`. A workspace operator gets scheduling only by wrapping `mainspring
  run` in their own cron entry today.
- **`run` Actions still aren't wired.** Carried over from v0.1: the gate
  validates a `run` Action against the declared `ToolSpec` list, and
  `dispatch.ts` accepts an optional `ToolRegistry`, but `loop.ts`'s
  `runSession` never passes one through — so a gate-allowed `run` reaches
  dispatch and returns `applied: false` ("no handler registered"). Tools can
  be declared and gated, not yet executed.
- **No gate feedback to the Brain.** The loop pushes only `role: "brain"`
  turns into `history`; a `role: "loop"` turn (surfacing *why* an Action was
  blocked, directly in-context) exists in the types but is never emitted. A
  Brain currently learns about a veto only indirectly, via the next
  `assemble()` picking up whatever did or didn't land on disk.
- **`maxSessionMs` is advisory.** The loop enforces `maxSteps`, not a
  wall-clock deadline, and `brain.step()` is not wrapped in a try/catch — a
  throw aborts the session before commit instead of degrading cleanly.
- **No dashboard.** `mainspring status` and `.mainspring/last-session.json`
  are the only introspection; there's no hosted or local UI over session
  history.

## Explicitly NOT planned

Some capabilities are deliberately out of scope. These are constitution-first
choices, not missing features — Mainspring is a framework for running a
business *honestly and legally*, and the framework should make the dishonest
path hard, not convenient:

- **No autonomous account creation.** Anything requiring a human attestation,
  a new account, or a signup goes through a `relay` Action to a human. The
  framework will never create accounts on a Brain's behalf.
- **No CAPTCHA or bot-check bypass.** Full stop. A bot check is a signal to
  file a `relay`, not an obstacle to defeat.
- **No dark patterns.** No fake reviews, sockpuppets, fabricated scarcity,
  impersonation, spam, or deceptive claims. The `scrub` gate and the
  Constitution's hard rules exist to keep output honest, not to launder it.
- **No secret exfiltration paths.** Secrets live in the operator's
  environment (`.env`), never in a `SessionInput`, and the gate blocks
  secret-shaped content from reaching a `write` or a `notify`. There will be
  no "convenience" feature that hands a Brain a credential.
- **No detection-evasion tooling.** Mainspring is for building things in the
  open (the project itself is an open, revenue-tracked experiment), not for
  hiding automated activity from platforms whose ToS it should respect.

If you need one of these to accomplish a task, that's the signal that a human
belongs in the loop — which is exactly what `relay` is for.

## Want to help?

The wiring gaps above are exactly where a PR has the most leverage right now
— each one is "call the tested package from the loop," not "design something
new." See [`docs/issue-drafts/`](./issue-drafts/) for five scoped starting
points, from a docs fix to a design discussion on pluggable storage.
