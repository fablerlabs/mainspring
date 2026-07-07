import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  recordResult,
  initialState,
  backoffDelayMs,
  DEFAULT_BACKOFF,
  matchesCron,
  parseCron,
  CronParseError,
  type BackoffPolicy,
  type Schedule,
  type ScheduleState,
} from "../src/index.js";

// A fixed anchor so every test is deterministic. 2026-07-07 14:30:00 UTC.
const T0 = Date.UTC(2026, 6, 7, 14, 30, 0);
const NO_STOP = { stopFilePresent: false } as const;

// --- interval cadence --------------------------------------------------------

test("interval: first run (no lastRun) is always due", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const d = decide(T0, s, initialState(), NO_STOP);
  assert.equal(d.run, true);
  assert.match(d.reason, /first run/);
});

test("interval: not due before the interval elapses", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const state: ScheduleState = { lastRun: T0, consecutiveFailures: 0 };
  const d = decide(T0 + 999, s, state, NO_STOP);
  assert.equal(d.run, false);
  assert.match(d.reason, /next run in 1ms/);
});

test("interval: due exactly at the boundary (elapsed == everyMs)", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const state: ScheduleState = { lastRun: T0, consecutiveFailures: 0 };
  const d = decide(T0 + 1000, s, state, NO_STOP);
  assert.equal(d.run, true, "the interval boundary is inclusive");
});

test("interval: due after the interval has passed", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const state: ScheduleState = { lastRun: T0, consecutiveFailures: 0 };
  assert.equal(decide(T0 + 5000, s, state, NO_STOP).run, true);
});

test("interval: focus is passed through only on a positive decision", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000, focus: "daily-report" };
  const due = decide(T0 + 1000, s, { lastRun: T0, consecutiveFailures: 0 }, NO_STOP);
  assert.equal(due.run, true);
  assert.equal(due.focus, "daily-report");

  const notDue = decide(T0 + 10, s, { lastRun: T0, consecutiveFailures: 0 }, NO_STOP);
  assert.equal(notDue.run, false);
  assert.equal(notDue.focus, undefined, "no focus leaks on a run:false decision");
});

// --- backoff -----------------------------------------------------------------

test("backoffDelayMs grows exponentially and is capped at maxMs", () => {
  const p: BackoffPolicy = { baseMs: 1000, factor: 2, maxMs: 8000 };
  assert.equal(backoffDelayMs(p, 0), 0, "no delay when not failing");
  assert.equal(backoffDelayMs(p, 1), 1000);
  assert.equal(backoffDelayMs(p, 2), 2000);
  assert.equal(backoffDelayMs(p, 3), 4000);
  assert.equal(backoffDelayMs(p, 4), 8000);
  assert.equal(backoffDelayMs(p, 5), 8000, "capped");
  assert.equal(backoffDelayMs(p, 50), 8000, "still capped, no overflow");
});

test("backoff blocks a due schedule until the delay elapses, then allows it", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  // One failure -> 5000ms backoff, which outlasts the 1000ms interval.
  const backoff: BackoffPolicy = { baseMs: 5000, factor: 2, maxMs: 100_000 };
  const state: ScheduleState = { lastRun: T0, consecutiveFailures: 1 };

  // Interval is due at T0+1000, but backoff still holds it back.
  const held = decide(T0 + 1000, s, state, { stopFilePresent: false, backoff });
  assert.equal(held.run, false);
  assert.match(held.reason, /backing off after 1 failure/);

  // Just before the backoff boundary: still held.
  assert.equal(decide(T0 + 4999, s, state, { stopFilePresent: false, backoff }).run, false);

  // At the backoff boundary (readyAt == now): cleared to run.
  assert.equal(decide(T0 + 5000, s, state, { stopFilePresent: false, backoff }).run, true);
});

test("backoff grows with each consecutive failure", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const backoff: BackoffPolicy = { baseMs: 1000, factor: 2, maxMs: 100_000 };

  // After 3 failures the delay is 1000 * 2^2 = 4000ms.
  const state: ScheduleState = { lastRun: T0, consecutiveFailures: 3 };
  assert.equal(decide(T0 + 3999, s, state, { stopFilePresent: false, backoff }).run, false);
  assert.equal(decide(T0 + 4000, s, state, { stopFilePresent: false, backoff }).run, true);
});

test("recordResult: failure grows the streak, success resets it and always stamps lastRun", () => {
  let state = initialState();
  assert.equal(state.consecutiveFailures, 0);

  state = recordResult(state, { now: T0, success: false });
  assert.deepEqual(state, { lastRun: T0, consecutiveFailures: 1 });

  state = recordResult(state, { now: T0 + 100, success: false });
  assert.deepEqual(state, { lastRun: T0 + 100, consecutiveFailures: 2 });

  state = recordResult(state, { now: T0 + 200, success: true });
  assert.deepEqual(state, { lastRun: T0 + 200, consecutiveFailures: 0 });
});

test("a reset failure streak removes backoff entirely on the next tick", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const backoff: BackoffPolicy = { baseMs: 5000, factor: 2, maxMs: 100_000 };
  // Was failing, then a success cleared it; lastRun is the success time.
  const healed: ScheduleState = { lastRun: T0, consecutiveFailures: 0 };
  const d = decide(T0 + 1000, s, healed, { stopFilePresent: false, backoff });
  assert.equal(d.run, true, "no failures => interval alone governs, no backoff wait");
});

test("DEFAULT_BACKOFF is used when no policy is supplied", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const state: ScheduleState = { lastRun: T0, consecutiveFailures: 1 };
  // Default baseMs is 60_000, so at +1000 (interval due) it is still backing off.
  assert.equal(backoffDelayMs(DEFAULT_BACKOFF, 1), 60_000);
  const d = decide(T0 + 1000, s, state, NO_STOP);
  assert.equal(d.run, false);
  assert.match(d.reason, /backing off/);
});

// --- STOP overrides everything ----------------------------------------------

test("STOP file forces run:false even when perfectly due and healthy", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  const state: ScheduleState = { lastRun: T0, consecutiveFailures: 0 };
  const d = decide(T0 + 10_000, s, state, { stopFilePresent: true });
  assert.equal(d.run, false);
  assert.match(d.reason, /STOP file present/);
});

test("STOP overrides a first-ever run and a cleared backoff alike", () => {
  const s: Schedule = { kind: "interval", everyMs: 1000 };
  assert.equal(decide(T0, s, initialState(), { stopFilePresent: true }).run, false);

  const cleared: ScheduleState = { lastRun: T0, consecutiveFailures: 5 };
  const d = decide(T0 + 10_000_000, s, cleared, { stopFilePresent: true });
  assert.equal(d.run, false, "STOP wins even past any backoff window");
});

// --- cron cadence ------------------------------------------------------------

test("cron: matches the exact UTC minute and nothing else", () => {
  // 14:30 UTC on any day/month.
  const s: Schedule = { kind: "cron", expr: "30 14 * * *" };
  const due = decide(T0, s, initialState(), NO_STOP);
  assert.equal(due.run, true);
  assert.match(due.reason, /matches now/);

  // One minute later: not due.
  assert.equal(decide(T0 + 60_000, s, initialState(), NO_STOP).run, false);
});

test("cron: does not fire twice within the same matching minute", () => {
  const s: Schedule = { kind: "cron", expr: "30 14 * * *" };
  // Ran at the top of this minute already.
  const minuteStart = Math.floor(T0 / 60_000) * 60_000;
  const state: ScheduleState = { lastRun: minuteStart, consecutiveFailures: 0 };
  const d = decide(T0 + 30_000, s, state, NO_STOP); // 30s into the same minute
  assert.equal(d.run, false);
  assert.match(d.reason, /already ran this minute/);
});

test("cron: an invalid expression fails safe (run:false), never throws", () => {
  const s: Schedule = { kind: "cron", expr: "99 14 * * *" }; // minute 99 out of range
  const d = decide(T0, s, initialState(), NO_STOP);
  assert.equal(d.run, false);
  assert.match(d.reason, /invalid schedule/);
});

test("cron: backoff still applies on top of a matching minute", () => {
  const s: Schedule = { kind: "cron", expr: "30 14 * * *" };
  const backoff: BackoffPolicy = { baseMs: 90_000, factor: 2, maxMs: 1_000_000 };
  // Failed one minute ago; the minute matches now but backoff (90s) holds.
  const state: ScheduleState = { lastRun: T0 - 60_000, consecutiveFailures: 1 };
  const held = decide(T0, s, state, { stopFilePresent: false, backoff });
  assert.equal(held.run, false);
  assert.match(held.reason, /backing off/);
});

// --- cron parsing ------------------------------------------------------------

test("matchesCron: wildcards, lists, ranges, and steps", () => {
  const wed = Date.UTC(2026, 6, 8, 9, 0, 0); // 2026-07-08 09:00 UTC is a Wednesday
  assert.equal(new Date(wed).getUTCDay(), 3, "sanity: it is Wednesday (3)");

  assert.equal(matchesCron("* * * * *", wed), true, "wildcard matches anything");
  assert.equal(matchesCron("0 9 * * *", wed), true, "09:00 matches");
  assert.equal(matchesCron("0 8 * * *", wed), false, "08:00 does not");
  assert.equal(matchesCron("0 9 * * 3", wed), true, "Wednesday matches dow 3");
  assert.equal(matchesCron("0 9 * * 1", wed), false, "Monday does not");
  assert.equal(matchesCron("0 9 * * 1-5", wed), true, "weekday range matches");
  assert.equal(matchesCron("0 9,17 * * *", wed), true, "hour list matches 9");
  assert.equal(matchesCron("0 */3 * * *", wed), true, "*/3 matches hour 9");
  assert.equal(matchesCron("0 */4 * * *", wed), false, "*/4 does not match hour 9");
  assert.equal(matchesCron("0 9 8 7 *", wed), true, "day-of-month 8, month 7 match");
});

test("cron: dom and dow are ANDed in this subset", () => {
  const wed8th = Date.UTC(2026, 6, 8, 0, 0, 0); // 8th, Wednesday
  // dom=8 (matches) AND dow=1/Monday (does not) => no match.
  assert.equal(matchesCron("0 0 8 * 1", wed8th), false);
  // dom=8 AND dow=3/Wednesday => match.
  assert.equal(matchesCron("0 0 8 * 3", wed8th), true);
});

test("parseCron rejects malformed and unsupported expressions", () => {
  assert.throws(() => parseCron("* * * *"), CronParseError, "too few fields");
  assert.throws(() => parseCron("* * * * * *"), CronParseError, "too many fields");
  assert.throws(() => parseCron("60 * * * *"), CronParseError, "minute out of range");
  assert.throws(() => parseCron("* 24 * * *"), CronParseError, "hour out of range");
  assert.throws(() => parseCron("MON * * * *"), CronParseError, "names unsupported");
  assert.throws(() => parseCron("*/0 * * * *"), CronParseError, "zero step");
  assert.throws(() => parseCron("5-1 * * * *"), CronParseError, "inverted range");
});
