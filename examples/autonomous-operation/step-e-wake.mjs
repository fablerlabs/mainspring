// Step (e): the wake loop. Two independent, fully deterministic decisions —
// (1) "should a session run this tick?" (cadence + STOP + failure backoff), and
// (2) "we just failed against the provider — when do we wake, or do we stop?".
// Neither reads the clock internally: `now` is always injected.
import { decide, recordResult, initialState } from "@mainspring/schedule";
import { classifyFailure, parseResetTime, nextWake } from "@mainspring/core";

const at = (iso) => Date.parse(iso);
const schedule = { kind: "cron", expr: "0 14 * * *", focus: "daily-report" }; // 14:00 UTC daily

// --- 1. Cadence + kill switch ---
let state = initialState();
console.log("A. cadence decisions (cron 0 14 * * *):");
console.log("  14:00 UTC:", decide(at("2026-07-07T14:00:00Z"), schedule, state, { stopFilePresent: false }));
console.log("  14:30 UTC:", decide(at("2026-07-07T14:30:00Z"), schedule, state, { stopFilePresent: false }));
console.log("  14:00 + STOP file present:", decide(at("2026-07-07T14:00:00Z"), schedule, state, { stopFilePresent: true }));

// --- 2. Failure backoff (a broken job waits longer each tick) ---
// Backoff only bites once the cadence is otherwise due, so use a 1s interval:
// the cadence clears immediately and we can watch the backoff hold the job off.
const fast = { kind: "interval", everyMs: 1000 };
console.log("\nB. exponential backoff after failures (interval 1s, default backoff base 60s):");
state = recordResult(initialState(), { now: at("2026-07-08T14:00:00Z"), success: false }); // 1 failure
const d1 = decide(at("2026-07-08T14:00:30Z"), fast, state, { stopFilePresent: false });
console.log("  30s after 1st failure:", d1.run, "—", d1.reason);
const d1b = decide(at("2026-07-08T14:01:05Z"), fast, state, { stopFilePresent: false });
console.log("  65s after 1st failure:", d1b.run, "—", d1b.reason);
state = recordResult(state, { now: at("2026-07-08T14:01:05Z"), success: false }); // 2 failures
const d2 = decide(at("2026-07-08T14:01:35Z"), fast, state, { stopFilePresent: false });
console.log("  30s after 2nd failure:", d2.run, "—", d2.reason);

// --- 3. Provider-limit backoff: classify the error, compute a single wake-at ---
console.log("\nC. provider-limit backoff (compute one wake-at, never hot-retry):");
const nowMs = at("2026-07-07T21:00:00Z");
for (const msg of [
  "Your usage limit resets 8:50pm (UTC).",
  "429 Too Many Requests — slow down",
  "401 Unauthorized: invalid x-api-key",
]) {
  const failure = classifyFailure(msg);
  const resetAtMs = parseResetTime(msg, nowMs);
  const wakeAt = nextWake({ failure, resetAtMs, attempt: 0, nowMs });
  const when = wakeAt === null ? "DO NOT RETRY — escalate to a human" : new Date(wakeAt).toISOString();
  console.log(`  ${failure.padEnd(11)} → ${when}`);
}
