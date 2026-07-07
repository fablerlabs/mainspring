# Mainspring docs

Reference and guides for the framework. Start with the [root
README](../README.md) for the one-page overview, then come here for depth.

| Doc | Purpose |
|---|---|
| [`architecture.md`](architecture.md) | The module map and the trust boundary: how `assemble → gate → dispatch → commit` splits "the Brain can propose anything" from "only trusted code writes," plus the known v0.1 gaps. |
| [`brains.md`](brains.md) | The full [`Brain`](../packages/core) contract — implementing `step()`, the `Action` kinds, the gate-feedback rules — followed by a worked `claude-brain` adapter (see [`@mainspring/brains`](../packages/brains)). |
| [`writing-a-constitution.md`](writing-a-constitution.md) | How to write a `CONSTITUTION.md` and keep it in sync with the machine-readable `constitution` object that [`gate.ts`](../packages/core) and [`@mainspring/governance`](../packages/governance) enforce: splitting hard rules / money / memory / escalation. |
| [`deploying.md`](deploying.md) | Running a workspace unattended, forever: the supervisor model, cron/systemd/CI recipes, the `STOP` kill switch, and privilege separation — the operator-side layer around `mainspring run`. |
| [`roadmap.md`](roadmap.md) | An honest map of what's shipped, what's in progress, and what's explicitly out of scope — refreshed against the code on `main` and [`CHANGELOG.md`](../CHANGELOG.md), not against intent. |
| [`publishing.md`](publishing.md) | Brain-side checklist for how the credentialed session publishes/refreshes the public GitHub repo. Not run from inside this repo (no secrets, no publish scripts here by design). |
| [`issue-drafts/`](issue-drafts) | Pre-written GitHub issue drafts for tracked gaps and proposals (e.g. the [`@mainspring/schedule`](../packages/schedule) README/example gaps, a second `OpenAIBrain` adapter, pluggable storage). Staging area for the brain to file. |

## See also

- [`../README.md`](../README.md) — the loop, the package table, and the
  Quickstart.
- [`../examples/README.md`](../examples/README.md) — runnable, offline proofs
  of each slice of the loop.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — dev setup, package layout, and
  how issues/PRs get triaged.
