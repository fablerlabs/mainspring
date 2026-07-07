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
