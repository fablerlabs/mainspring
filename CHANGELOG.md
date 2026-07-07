# Changelog

All notable changes to the Mainspring packages are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

Initial public package set. Everything below is pre-1.0 and may change
without a major bump.

### Added

- **`@mainspring/core`** — the swappable-`Brain` contract and the
  constitution-enforcing session loop (`assemble`, `gateAction(s)`,
  `applyAction(s)`, `runSession`).
- **`@mainspring/governance`** — constitution-as-code: hard rules the brain
  cannot override, loaded from `CONSTITUTION.md` and enforced as `Action`
  guards.
- **`@mainspring/ledger`** — append-only `LEDGER.csv` management with
  balance invariants and spend-cap thresholds.
- **`@mainspring/memory`** — deterministic `STATE.md` compaction, journal,
  and session-log utilities for the amnesiac session loop.
- **`@mainspring/relay`** — a zero-dependency client for the Fabler Relay
  human-in-the-loop wire protocol.
- **`@mainspring/scrub`** — a secret-shaped-string scan gate run before any
  publish or notify action.
- **`@mainspring/brains`** — reference `Brain` implementations: a scripted
  `MockBrain` and a zero-SDK `ClaudeBrain` adapter for Anthropic's Messages
  API.
- **`@mainspring/cli`** — the `mainspring` command (`init`, `run`, `status`,
  `doctor`) for scaffolding and operating a workspace.
- **`@mainspring/broker`** — capability-gated side effects: register a
  `Capability` with a `Cap` (max amount, max calls/day, target allowlist),
  exercise it only through `Broker#request`, fail closed on anything
  unregistered or over cap, with one audit entry per attempt whether allowed
  or denied.

### Changed

- **`@mainspring/core`** — `dispatch` now accepts an optional injected
  `Broker` (`applyAction(s)` and `runSession({ broker })`). When provided,
  money-moving/external Actions (`expense` ledger lines, `run`, `notify`,
  `relay`) are authorized and audited by `@mainspring/broker` before any
  workspace effect; a broker denial (over-cap, off-allowlist, or an
  unregistered capability — fail-closed) surfaces as a gate-style refusal.
  The seam is structural (`BrokerLike`), so `core` keeps zero runtime
  dependencies. With no broker injected, dispatch behavior is unchanged.
- **`@mainspring/cli`** — `mainspring init` grew `--template minimal|full`
  (Constitution variant selection, `minimal` by default) and `--force`
  (scaffold into a non-empty directory); it now also creates `journal/` up
  front and locates its templates robustly from both the production and test
  builds. A freshly-init'd workspace passes `mainspring doctor` with exit 0
  and runs the echo Brain end to end.
