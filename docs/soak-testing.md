# Soak testing

`mainspring/tools/soak.mjs` drives the real `@mainspring/core` session loop —
`assemble -> brain.step -> gate -> dispatch -> commit`, via the exported
`runSession` — for hundreds or thousands of simulated sessions against a
throwaway git repo, with a deterministic scripted Brain (no network, no API
key). It exists to answer one question honestly: **does a long-lived
Mainspring workspace actually survive a long horizon**, or does it silently
bloat, corrupt, or wedge itself somewhere nobody's looked yet?

This doc explains how to run it, what every number in its report means, and
pastes the real output of one full 1000-session run.

## What it actually tests

- **The real loop, unmodified.** The harness imports the compiled
  `@mainspring/core` and `@mainspring/memory` packages from `dist/` — the
  same artifacts `mainspring run` uses — and calls the exported `runSession`.
  It does not reimplement or stub gate/dispatch logic.
- **A scripted, seeded Brain**, not a real model. Each session it proposes a
  realistic mix of actions: journal notes, a `STATE.md` update (compacted via
  the real `compactState` from `@mainspring/memory`), ledger entries,
  work-order/relay/notify actions, and — deliberately — a slice of
  gate-*blocked* and outright malformed actions (see "Probe modes" below).
  Every probe mode is chosen to land in one specific `gate.ts` decision
  branch, so the report's reason buckets map 1:1 onto real code paths instead
  of being guessed at.
- **A simulated calendar.** Real sessions happen a few times a day over
  months; the harness can't wait months, so it patches the process-local
  `Date` (a standard fake-timers technique, undone at exit) and advances it
  4–10 simulated hours after every session. A 1000-session run therefore
  covers roughly 8-9 months of simulated business time in well under a
  minute of wall clock.
- **Crash + resume.** ~2.5% of sessions are flagged as a crash test: the
  session runs for real (assemble/step/gate/dispatch all execute exactly as
  normal) but with `commit: false` — simulating the process dying after
  dispatch, before `git commit`, which is the actual sequence `loop.ts` runs.
  On top of that, the harness truncates a random 1-30 bytes off the tail of
  whichever file was written most recently (`LEDGER.csv` if it's big enough,
  `STATE.md` otherwise) — simulating a torn write from a real `kill -9`. The
  next session then runs normally, and "resumed OK" means: it didn't throw,
  and the workspace's git tree is clean afterward (the next session's own
  `git add -A && git commit` sweeps up the crashed session's orphaned
  changes, exactly like the real supervisor would on restart).

## Running it

```bash
# from mainspring/ — build first, the harness imports dist/ output directly
pnpm -r build

# full soak (default 1000 sessions, seeded — same seed always reproduces
# the same scenario mix, though wall-clock timings will vary by machine)
node tools/soak.mjs
node tools/soak.mjs --sessions 5000 --seed 7   # longer horizon, different seed

# CI-friendly smoke mode (also wired as an npm script, NOT part of `pnpm -r test`
# — it's a soak test, not a unit test, and shouldn't run on every CI push)
pnpm run soak:smoke   # node tools/soak.mjs --sessions 50 --seed 1
```

Flags: `--sessions N` (default 1000), `--seed N` (default 42), `--out path`
(default `tools/.soak-reports/report-s<N>-seed<S>.json`, gitignored),
`--keep` (leave the temp workspace on disk instead of deleting it — useful
for inspecting a run by hand).

The temp workspace lives under the OS temp dir (`mkdtemp`), is its own
independent git repo, and is deleted at the end unless `--keep` is passed. It
never touches the real mainspring repo.

## Reading the report

Console output prints a live progress line every 50 sessions plus a final
summary; the same data (plus per-50-session samples) is written as JSON to
`--out`.

- **`totals`** — actions proposed/allowed/blocked across the whole run, and
  simulated total ledger spend (meaningless as a dollar figure — it's from
  the scripted brain's fake ledger entries — but a sanity check that the
  gate's per-session cap is actually doing something across hundreds of
  sessions rather than always/never firing).
- **`gateBlocksByReason`** — every blocked action's reason string, bucketed
  by which `gate.ts` branch produced it (`ledger-exceeds-session-cap`,
  `write-path-escape`, `write-forbidden-target`, `write-secret-like-content`,
  `notify-secret-like-content`, `run-unknown-tool`, `ledger-negative-amount`,
  `ledger-non-finite-amount`, `unknown-action-kind`). Every one of these
  categories should have a non-zero count on any run with enough sessions —
  if one goes to zero across a big run, that's worth a second look (either
  the probe stopped firing, or the gate stopped blocking it).
- **`compaction`** — how many times `@mainspring/memory`'s `compactState` ran
  and dropped entries (real, not simulated), the final `STATE.md` size, and
  an *estimated* size if compaction had never run (extrapolated from the
  actual byte cost of the first ~40 uncompacted entries × total sessions).
  The gap between "actual" and "estimated" is the compaction win.
- **`crash`** — how many sessions were flagged as a crash test and how many
  of those resumed cleanly (see above). `failures` lists any that didn't,
  with enough detail (which session, whether the next session threw, whether
  the tree was clean) to reproduce with `--keep --seed <same seed>`.
- **`sizeSamples` / `wallMsSamples`** — bytes and average per-session wall
  time, sampled every 50 sessions, so you can see the growth *curve* rather
  than just start/end numbers.
- **`wallTimeTrendPct`** — percent change from the first sampled window's
  average ms/session to the last. This is a **relative trend, not an
  absolute performance number** — it depends heavily on the host's disk,
  git version, and how busy the machine is at the time (see caveat below) —
  but a large upward trend is worth knowing about regardless of the exact
  machine, and is documented rather than hidden here.

## What one real 1000-session run found

Run on this machine (labeled honestly, not the literal production VPS — a
small shared Linux sandbox: 4 vCPUs, 7.6 GiB RAM, Node v22.23.1, x86_64,
`uname -a`: `Linux ... 7.0.0-27-generic #27-Ubuntu SMP PREEMPT_DYNAMIC ...`).
No arguments needed changing from the defaults:

```
$ node tools/soak.mjs --sessions 1000 --seed 42
soak: workspace /tmp/mainspring-soak-uKju2V
soak: sessions=1000 seed=42
soak: session 50/1000 — total 17.9KB, avg 28.6ms/session (last 50), crashes tested 0
soak: session 100/1000 — total 28.5KB, avg 31.0ms/session (last 50), crashes tested 0
soak: session 150/1000 — total 42.2KB, avg 27.7ms/session (last 50), crashes tested 2
soak: session 200/1000 — total 53.3KB, avg 34.5ms/session (last 50), crashes tested 2
soak: session 250/1000 — total 64.5KB, avg 41.0ms/session (last 50), crashes tested 4
soak: session 300/1000 — total 73.8KB, avg 38.9ms/session (last 50), crashes tested 4
soak: session 350/1000 — total 85.0KB, avg 47.9ms/session (last 50), crashes tested 6
soak: session 400/1000 — total 95.9KB, avg 48.2ms/session (last 50), crashes tested 6
soak: session 450/1000 — total 106.9KB, avg 51.7ms/session (last 50), crashes tested 6
soak: session 500/1000 — total 117.1KB, avg 54.7ms/session (last 50), crashes tested 6
soak: session 550/1000 — total 126.8KB, avg 53.7ms/session (last 50), crashes tested 8
soak: session 600/1000 — total 137.9KB, avg 70.0ms/session (last 50), crashes tested 10
soak: session 650/1000 — total 149.5KB, avg 67.9ms/session (last 50), crashes tested 11
soak: session 700/1000 — total 160.4KB, avg 64.7ms/session (last 50), crashes tested 13
soak: session 750/1000 — total 169.8KB, avg 60.0ms/session (last 50), crashes tested 13
soak: session 800/1000 — total 180.7KB, avg 116.2ms/session (last 50), crashes tested 13
soak: session 850/1000 — total 192.4KB, avg 107.0ms/session (last 50), crashes tested 13
soak: session 900/1000 — total 203.4KB, avg 118.4ms/session (last 50), crashes tested 15
soak: session 950/1000 — total 216.1KB, avg 111.7ms/session (last 50), crashes tested 15
soak: session 1000/1000 — total 227.3KB, avg 91.0ms/session (last 50), crashes tested 18

=== soak summary ===
sessions completed: 1000/1000
actions: 4310 proposed, 3869 allowed, 441 blocked
gate blocks by reason:
  run-unknown-tool: 61
  ledger-exceeds-session-cap: 57
  ledger-negative-amount: 55
  write-secret-like-content: 52
  notify-secret-like-content: 50
  ledger-non-finite-amount: 49
  write-forbidden-target: 43
  unknown-action-kind: 37
  write-path-escape: 37
crash/resume: 18/18 clean resumes
STATE.md compaction: triggered 854x, dropped 949 entries total, final 8216B vs. estimated 151226B with no compaction
wall time trend: 218.08% (first window avg -> last window avg, ms/session)
wall clock for this whole soak run: 63.9s
full report: mainspring/tools/.soak-reports/report-s1000-seed42.json
```

Real wall clock for the whole 1000-session run: **64 seconds**. Zero fatal
errors. The full JSON report (per-50-session size/timing samples, every
crash's torn-write detail) is committed nowhere by default — `--out` writes
it under the gitignored `tools/.soak-reports/`; regenerate it by re-running
the command above with `--seed 42`.

### What this run showed, plainly

- **1000/1000 sessions completed, 0 fatal errors, 18/18 crash-and-resume
  tests came back clean.** No unhandled exception, no wedged workspace, no
  data loss across a simulated 8-9-month horizon.
- **Every gate-block category fired dozens of times** (37-61 each), so the
  block counts aren't an artifact of one lucky/unlucky path — the gate is
  consistently doing its job across the whole horizon, including a genuine
  spend-cap enforcement path (`ledger-exceeds-session-cap`: 57).
- **`STATE.md` compaction is real and effective**: it triggered 854 times,
  dropped 949 stale session-log entries, and held the file at ~8.2 KB the
  entire run instead of the ~148 KB it's estimated to have reached
  uncompacted — a >94% reduction. This is the actual `compactState` function
  from `@mainspring/memory` doing real work, not a simulated number.
- **`LEDGER.csv` grows linearly and unboundedly** (~50 bytes/session here,
  reaching ~49.9 KB after 1000 sessions) because nothing compacts it — by
  design, a ledger should be a complete permanent record, not summarized
  away. Worth knowing for real deployments: at this rate a business running
  a few sessions/day for several years would accumulate a multi-megabyte
  `LEDGER.csv`, still perfectly readable/parseable but eventually worth
  archiving old years rather than compacting them.
- **Wall time per session trended up** (~29ms/session in the first window to
  ~91-118ms in the later windows, +218% first-to-last). This machine is a
  shared sandbox — `time` on this run showed 33s of `sys` time against only
  16s of `user` time, meaning the growth is dominated by OS/git subprocess
  overhead (more commits, more files to `git add -A`/`diff --stat`/`commit`
  each session, i.e. `git`'s own linear-ish cost as a repo's history grows)
  and host scheduling noise, not CPU-bound JS work in the loop itself. Treat
  the exact percentage as this-machine-and-moment-specific — the useful,
  portable fact is the *direction* (sessions get slower, not faster, as
  history accumulates), not the absolute number.

## Bugs this soak run found

See `RESULT-q101.md` for the full writeup. Summary:

1. **Fixed** — `packages/core/src/gate.ts`'s ledger check compared
   `amountUsd < 0` without checking `Number.isFinite` first. A `NaN` or
   `Infinity` `amountUsd` compared false against every threshold, so it
   silently passed the gate as "allowed" — and for an expense, poisoned
   `loop.ts`'s running `spentUsd` with `NaN`, which then compares false
   against the per-session cap for every subsequent action *for the rest of
   that session*, a real spend-cap bypass. `@mainspring/governance`'s
   `checkSpendPolicy` already guards against exactly this (with a comment
   describing this exact failure mode) — core's own `gate.ts` just didn't
   have the matching check. Fixed to match, with new tests in
   `packages/core/test/gate.test.ts`.
2. **Reported, not fixed** — `runSession` (`packages/core/src/loop.ts`)
   writes `.mainspring/last-session.json` *after* the git commit, so that
   file always trails one commit behind in git history, on every session,
   crash or not. Harmless today (nothing in the codebase reads the file —
   verified by grep), but would be worth writing before the commit (or
   dropping the `commitDetail` field, which needs the commit to already have
   happened) before anything comes to depend on it being accurate.
3. **Reported, not fixed / not a bug** — `runSession`'s `RunSessionOptions`
   never passes a `toolRegistry` through to `dispatch.ts`, and
   `packages/cli/src/commands/run.ts` doesn't construct one either. So any
   `run` action that the gate allows (tool name is in the declared
   allowlist) currently always dispatches as `applied: false, detail: "no
   handler registered"` — the whole `run`/tool pathway is gate-tested but
   not yet end-to-end wired through the public CLI entry point. This may be
   intentional (tool wiring being left to whoever embeds `@mainspring/core`)
   but is worth a deliberate decision rather than a silent gap.
