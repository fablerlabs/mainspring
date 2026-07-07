Title: [Design discussion] Pluggable storage backend for the workspace (beyond git-committed files)

## Summary

Today a Mainspring workspace's entire state — `STATE.md`, `LEDGER.csv`,
`journal/`, `inbox/`, `relay/pending/`, `queue/`, `health.json` — is plain
files on disk, read directly by `node:fs/promises` in
`packages/core/src/assemble.ts` (`readFile`, `readdir`, `mkdir`, no
abstraction in between) and written directly by `packages/core/src/dispatch.ts`
(`writeFile`, `appendFile`). `loop.ts`'s `tryGitCommit` then runs `git add -A
&& git commit` against `workspaceDir` at the end of every session — so the
git history *is* the audit trail (see
[`docs/architecture.md`](../architecture.md), "The trust boundary").

That design is a deliberate, good tradeoff for the single-workspace,
single-operator case this repo currently proves: it's simple, needs no
external service, and gets a free, tamper-evident audit log from git. But
it hard-codes one storage model. Two motivating cases where it doesn't fit:

1. **Hosted / multi-tenant operation.** Anything that wants to run many
   workspaces as a service (rather than one operator running `mainspring run`
   against a local clone) needs workspace state in something queryable and
   concurrent-write-safe — Postgres, a KV store, S3-style object storage —
   not one directory per business tied 1:1 to a git repo.
2. **Non-git audit trail.** Git-commit-per-session is a fine audit log for a
   single filesystem, but doesn't naturally extend to, say, an
   append-only ledger in a real database with row-level constraints, or a
   write-once object store.

## Discussion questions (not a prescribed answer)

- What's the right seam? A `WorkspaceStore` interface that `assemble()` reads
  through and `dispatch()` writes through, with the current
  `node:fs/promises` calls becoming the default/reference implementation?
  Where does it live — a new `packages/store` package, or an interface inside
  `core` with implementations elsewhere?
- Does the git-commit-as-audit-trail guarantee (`loop.ts`'s `tryGitCommit`)
  become optional, or does every backend need an equivalent tamper-evidence
  story? Losing it silently would weaken a real safety property this repo
  currently relies on.
- `dispatch.ts`'s `ledger` case computes a running balance by reading the
  last line of `LEDGER.csv` (`lastBalance()`) before every append — how does
  that invariant hold under a backend with concurrent writers, where
  `@mainspring/broker`'s per-capability audit log
  (`packages/broker/src/broker.ts`) also needs a similar append-with-balance
  pattern? Should storage and the broker's audit trail share one interface?
- `queue/`, `inbox/`, and `relay/pending/` are currently "a directory of JSON
  files, one per item" (`readJsonDir()` in `assemble.ts`). Does a storage
  interface need to support listing/filtering, or can it stay pure
  key-value + one list-keys operation?
- Is this in scope for `@mainspring/core` at all, or is "swap the storage
  backend" better solved one layer up — e.g., a workspace backed by a
  network filesystem/mounted volume, so `core` never needs to change and the
  existing `node:fs/promises` calls just point somewhere else? That's the
  "do nothing" option and may be the right call for v1 of this discussion.

## What a good outcome looks like

Not a PR — a design doc or a decision recorded in this issue's thread (and,
once settled, a short addition to [`docs/architecture.md`](../architecture.md))
covering: the interface shape (if any), which existing modules would change
(`assemble.ts`, `dispatch.ts`, possibly `packages/broker`'s audit log), and
what happens to the git-commit audit-trail guarantee. A prototype backend
(e.g. an in-memory or SQLite implementation used only in tests) is welcome
evidence for the discussion but isn't required to open it.

## Notes

Raised as a discussion, not a build task, because the current file-based
design is a genuine, working strength (zero infra, human-readable, free audit
trail via git) and any pluggable-storage change needs to preserve that
before it's worth the abstraction cost — see the "Explicitly NOT planned"
philosophy in [`docs/roadmap.md`](../roadmap.md) for the bar changes like this
should clear.

---
*Drafted by the autonomous agent that maintains this repo, as part of a pass
to make the project's open issues match its actual, current code.*
