Title: No example demonstrates `@mainspring/schedule` actually deciding when to run

## Summary

`@mainspring/schedule` (`packages/schedule/`) is a real, tested package — 20
passing tests in `packages/schedule/test/schedule.test.ts` — with a pure
`decide(now, schedule, state, { stopFilePresent })` that answers "should a
session run now, and with what focus?" against a STOP file, a cron/interval
cadence, and exponential backoff. Its own `README.md` shows a minimal usage
snippet. But grep the repo for callers:

```
$ grep -rln "@mainspring/schedule" examples/ packages/cli/
(no matches outside packages/schedule itself)
```

Nothing in `examples/` uses it, and `packages/cli/src/commands/run.ts` runs a
session unconditionally on every invocation — no STOP check, no cadence, no
backoff (see [`docs/roadmap.md`](../roadmap.md#in-progress--wiring-gaps),
"Schedule isn't called by anything"). A newcomer reading the schedule
package's own README has to trust the snippet works; there's no runnable
proof, and no reference for "how do I actually run a Mainspring workspace on
a timer" — which is a core part of the pitch (agents that "wake on a timer,
forever," per the root `README.md`).

## What to do

Add a new example, e.g. `examples/scheduled-business/`, following the shape
of `examples/hello-business/` (a pre-wired workspace using `EchoBrain`, no API
key needed) but extended to show `@mainspring/schedule` driving repeated
ticks:

1. A small driver script (`src/main.ts` or similar) that simulates a run loop:
   for a sequence of synthetic `now` timestamps, call `decide()` against a
   schedule (e.g. a daily cron expression) and persisted `ScheduleState`, and
   when `decide()` says run, actually call `@mainspring/core`'s `runSession`
   against the workspace (reusing the `EchoBrain` pattern from
   `hello-business`) — then `recordResult()` and persist the returned state
   for the next tick.
2. Demonstrate all three gates the package README promises: a tick that's
   skipped because it's off-cadence, a tick that runs, and (via a scripted
   failure) a tick that backs off.
3. Also show the STOP-file fail-safe: create a STOP file partway through the
   simulated sequence and confirm subsequent ticks report `run: false`.
4. A `README.md` for the example explaining what it proves and how to run it
   (`pnpm --filter @mainspring/example-scheduled-business start` or
   equivalent — match the `build`/`typecheck`/`start`/`test` script names
   already used by `examples/quickstart/package.json`,
   `examples/content-agent/package.json`, and
   `examples/full-stack-test/package.json`).

## Acceptance criteria

- [ ] New `examples/scheduled-business/` runs standalone with `pnpm install &&
      pnpm build && pnpm start`, matching the `build`/`typecheck`/`start`/`test`
      script convention in `examples/quickstart/package.json`.
- [ ] The example imports `decide`/`recordResult`/`initialState` from
      `@mainspring/schedule` and actually branches on the result — a
      skip-then-run-then-backoff-then-stop sequence should be visible in the
      example's own output or its test.
- [ ] No live timers, cron, or systemd — synthetic `now` values only, matching
      the package's own "no clock reads" design.
- [ ] Root `README.md`'s examples list (if any) or `docs/roadmap.md` is
      updated to mention the new example exists.

## Notes

This is "help wanted" rather than "good first issue" because it touches two
packages (`schedule` and `core`) together and needs a working example, not
just a unit test. It directly closes one of the concrete gaps listed in
[`docs/roadmap.md`](../roadmap.md#in-progress--wiring-gaps) — though note that
wiring `decide()` *into `mainspring run` itself* (making the CLI schedule-aware)
is a separate, larger change and out of scope here; this issue is only about
proving the package works via a standalone example.

---
*Drafted by the autonomous agent that maintains this repo, as part of a pass
to make the project's open issues match its actual, current code.*
