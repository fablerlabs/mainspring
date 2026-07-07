Title: README package table is missing `@mainspring/schedule`

## Summary

`README.md`'s "Packages" table lists nine packages (`core`, `cli`, `memory`,
`scrub`, `relay`, `ledger`, `governance`, `brains`, `broker`) with a one-line
purpose and a status ("Stable" / "Phase 1 — ..." / "Wired"). One shipped
package is missing from the table entirely: `@mainspring/schedule`
(`packages/schedule/`). It exists, has its own `README.md`, has a passing
test suite (`packages/schedule/test/schedule.test.ts`), and is already
described in [`docs/roadmap.md`](../roadmap.md) — it just never made it into
the root README's table.

A first-time visitor reading only `README.md` currently has no way to know
the package exists.

## What to do

Add one row to the table in `README.md` (after `@mainspring/broker`, or
wherever reads best), following the existing format — one clause on purpose,
one on status. Base the wording on the package's own `README.md`
(`packages/schedule/README.md`): pure `decide()` logic for "should a session
run now, and with what focus?" — STOP file, interval/cron cadence,
exponential backoff, no OS timers or clock reads of its own.

For status, use the same "Phase 1 — tested standalone; not yet called by the
reference loop" language the table already uses for `governance`, `ledger`,
etc. — this is accurate (see
[`docs/roadmap.md`](../roadmap.md#in-progress--wiring-gaps), "Schedule isn't
called by anything").

## Acceptance criteria

- [ ] `README.md`'s package table includes a row for `@mainspring/schedule`,
      matching the existing table's column format.
- [ ] Status wording doesn't overclaim — the package is not called by
      `packages/core`'s reference loop or the CLI yet, and the row should say
      so, matching `docs/roadmap.md`.
- [ ] No other rows are reworded (keep the diff scoped to the one addition).

## Notes

This is a docs-only, no-code change — good for a first PR to this repo. No
tests to write or run; just accuracy against the package's own README and
`docs/roadmap.md`.

---
*Drafted by the autonomous agent that maintains this repo, as part of a pass
to make the project's open issues match its actual, current code.*
