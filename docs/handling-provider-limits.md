# Handling provider limits (don't hot-retry)

> **Motivating incident (2026-07-07).** A host plan's session limit was
> exhausted. A naive supervisor treated the resulting failures as generic and
> retried the agent **115 times in ~3 hours** — roughly one retry every 90
> seconds — every one of which failed immediately, because the condition could
> not clear until the plan's fixed reset time later that evening. The retries
> burned quota and money and shipped nothing. This guide is the productized
> lesson.

## Why hot-retry is harmful

When a provider says "you're out of quota until 8:50pm," retrying at 9:01pm,
9:02pm, 9:03pm… does not help — the answer is the same until 8:50pm arrives.
Worse, on some plans each attempt still costs a request (and, for agent loops,
a full session spin-up), so a tight retry loop actively *drains* the very
budget you're waiting to recover. The correct behavior is to compute a single
**wake-at** time and sleep until then — or, for failures a retry can never fix
(bad credentials), to stop and get a human.

Not all failures are the same, and the right wait differs by class:

| Failure class | What it means | Right response |
|---|---|---|
| `usage-limit` | Plan / quota / credit exhausted | Wake **at the reset time** (or +30min if unknown). Retrying sooner is pointless. |
| `rate-limit` | Too many requests too fast | **Exponential backoff** (2^attempt × 60s, capped). Self-clears quickly. |
| `overloaded` | Provider over capacity (transient) | Same exponential backoff. |
| `auth` | Bad / expired / missing credentials | **Do not auto-retry.** Escalate to a human — a retry can never fix this. |
| `unknown` | Unrecognized | Fail safe: **escalate**, don't guess a retry that might hammer a hard error. |

## The helper

`@mainspring/core` exposes three pure functions (no `Date.now()` inside — the
clock is always injected, so they're fully testable):

```ts
import { classifyFailure, parseResetTime, nextWake } from "@mainspring/core";

// 1. Which class of failure is this?
classifyFailure("Your usage limit resets 8:50pm (UTC)."); // → "usage-limit"

// 2. When does it reset? (epoch ms, or null if the text names no time)
parseResetTime("Your usage limit resets 8:50pm (UTC).", nowMs); // → epoch ms

// 3. When should I wake — or should I not retry at all?
nextWake({ failure, resetAtMs, attempt, nowMs, capMs }); // → epoch ms | null
```

`nextWake` returns an **absolute epoch (ms) to wake at**, or `null` meaning
*"do not auto-retry — escalate to a human."*

## Wiring it into a supervisor loop

The shape below is what a supervisor (or an agent's own retry wrapper) should
do. `null` from `nextWake` is the escalation signal.

```ts
import { classifyFailure, parseResetTime, nextWake } from "@mainspring/core";

async function superviseWithBackoff(runOnce: () => Promise<void>, escalate: (why: string) => void) {
  let attempt = 0;
  for (;;) {
    try {
      await runOnce();
      attempt = 0; // success resets the backoff ladder
      return;
    } catch (err) {
      const text = String((err as Error)?.message ?? err);
      const nowMs = Date.now(); // the ONE place the real clock enters

      const failure = classifyFailure(text);
      const resetAtMs = parseResetTime(text, nowMs);
      const wakeAt = nextWake({ failure, resetAtMs, attempt, nowMs });

      if (wakeAt === null) {
        // auth / unknown — a retry can't fix it. Stop and get a human.
        escalate(`Unretryable failure (${failure}): ${text}`);
        return;
      }

      const sleepMs = Math.max(0, wakeAt - nowMs);
      console.warn(`[backoff] ${failure}: sleeping ${Math.round(sleepMs / 1000)}s until ${new Date(wakeAt).toISOString()}`);
      await new Promise((r) => setTimeout(r, sleepMs));
      attempt += 1; // only the transient classes ever consult `attempt`
    }
  }
}
```

Notes:

- **Inject the clock at the boundary.** The helpers never call `Date.now()`;
  the supervisor reads the real clock once and passes `nowMs` in. That keeps
  the decision logic deterministic and unit-testable.
- **`attempt` only matters for the transient classes.** For `usage-limit` the
  wait is dictated by the reset time, not by how many times you've tried, so a
  usage-limit loop won't creep upward — it wakes at the reset, once.
- **Cap the sleep.** `nextWake`'s `capMs` (default 1h) bounds exponential
  backoff. For very long `usage-limit` waits, a supervisor that can't sleep for
  hours should instead persist `wakeAt` and exit, waking on a timer/cron at or
  after that instant.

## The escalate-to-human rule for auth failures

An authentication failure (`401`, `invalid x-api-key`, expired credential) is
**never** self-healing: the credential is wrong or gone, and every retry will
fail identically while looking like progress. `nextWake` returns `null` for
both `auth` and `unknown` precisely so a loop *cannot* silently hammer them —
the only correct move is to stop and page a human (in Mainspring terms, a
`notify`/`relay` action, not a retry). Treating `unknown` the same way is
deliberate: if we didn't recognize the error, we don't get to guess that
retrying is safe.

## Recognized reset-time shapes

`parseResetTime` handles the wording providers actually emit:

- **Clock** — `"resets 8:50pm (UTC)"`, `"resets at 20:50"`, `"8:50 am"`.
  12-hour clocks are normalized to 24-hour; the time is placed on the UTC day
  of `nowMs`, and if it's already past, it rolls to the next day (so
  `"resets 8:50pm"` seen *after* 8:50pm correctly points at tomorrow).
- **ISO 8601** — `"2026-07-07T20:50:00Z"` (a bare, tz-less ISO is read as UTC).
- **Relative** — `"in 30 minutes"`, `"in 2 hours"`, `"in 45 min"`, `"in 90s"`.

If no time is present it returns `null`, and `nextWake` falls back to a fixed
30-minute wait for `usage-limit` — long enough not to hot-loop, short enough to
recover promptly once the plan resets.
