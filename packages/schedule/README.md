# @mainspring/schedule

Pure, model-agnostic logic for the one question a long-lived agent asks each
tick: **should a session run now, and with what focus?** No OS timers, no
processes, no clock reads, no filesystem — the caller passes `now` (epoch ms)
and whether a STOP file exists, and `decide()` returns a verdict. That makes it
deterministic and trivially testable, and lets any host drive it: cron,
systemd, CI, or a bare `while` loop.

Three gates, checked safest-first:

1. **STOP file** — if present, never run (fail-safe kill switch).
2. **Cadence** — a fixed `interval`, or a `cron` subset matched against the UTC
   minute of `now`.
3. **Backoff** — while failing, wait an exponentially growing delay before retry.

```ts
import { decide, recordResult, initialState } from "@mainspring/schedule";

const schedule = { kind: "cron", expr: "0 14 * * *", focus: "daily-report" };
let state = initialState();

// once per tick, from cron/systemd/loop:
const d = decide(now, schedule, state, { stopFilePresent: existsSync("STOP") });
if (d.run) {
  const ok = await runSession(d.focus);
  state = recordResult(state, { now, success: ok }); // persist as JSON
}
```

Cron subset: five fields `min hour dom month dow` with `*`, lists, `a-b`
ranges, and `*/step`; UTC only; `dom`/`dow` are ANDed. Named months/days,
`?`, `L`, `W`, `#` are unsupported (they throw, and `decide` fails safe).

Zero runtime dependencies. Apache-2.0.
