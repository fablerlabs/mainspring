import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure, nextWake, parseResetTime } from "../src/index.js";
import type { FailureKind } from "../src/index.js";

/**
 * Backoff helper: turn provider error text into a retry decision without ever
 * hot-looping. Regression anchor is the 2026-07-07 incident where a naive
 * supervisor retried an exhausted session limit 115× in 3 hours. Every case
 * injects `nowMs` — no clocks, no timers, no network.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

// A fixed anchor: 2026-07-07T10:00:00Z (before the 8:50pm reset that day).
const JUL7_10AM = Date.UTC(2026, 6, 7, 10, 0, 0, 0);
// 2026-07-07T21:00:00Z — after 8:50pm the same day.
const JUL7_9PM = Date.UTC(2026, 6, 7, 21, 0, 0, 0);

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

test("classifyFailure recognizes the real usage-limit wording from the incident", () => {
  assert.equal(classifyFailure("Claude usage limit reached. Your limit resets 8:50pm (UTC)."), "usage-limit");
  assert.equal(classifyFailure("You have hit the session limit for your plan."), "usage-limit");
  assert.equal(classifyFailure("Insufficient credit remaining on your account."), "usage-limit");
  assert.equal(classifyFailure("monthly quota exceeded"), "usage-limit");
});

test("classifyFailure recognizes rate limits (429-style)", () => {
  assert.equal(classifyFailure("Rate limit exceeded"), "rate-limit");
  assert.equal(classifyFailure("HTTP 429 Too Many Requests"), "rate-limit");
  assert.equal(classifyFailure('{"type":"rate_limit_error"}'), "rate-limit");
});

test("classifyFailure recognizes overloaded / capacity errors", () => {
  assert.equal(classifyFailure("Overloaded"), "overloaded");
  assert.equal(classifyFailure('{"type":"overloaded_error"}'), "overloaded");
  assert.equal(classifyFailure("503 Service Unavailable"), "overloaded");
});

test("classifyFailure recognizes auth failures", () => {
  assert.equal(classifyFailure("401 Unauthorized"), "auth");
  assert.equal(classifyFailure("invalid x-api-key"), "auth");
  assert.equal(classifyFailure("authentication_error: please log in"), "auth");
});

test("classifyFailure is case-insensitive and tolerant of wrapping", () => {
  assert.equal(classifyFailure("ERROR: Your USAGE LIMIT has been reached"), "usage-limit");
  assert.equal(classifyFailure("   too many requests   "), "rate-limit");
});

test("classifyFailure returns unknown for unrelated / empty / non-string text", () => {
  assert.equal(classifyFailure("the model returned a short answer"), "unknown");
  assert.equal(classifyFailure(""), "unknown");
  assert.equal(classifyFailure(undefined as unknown as string), "unknown");
  assert.equal(classifyFailure(42 as unknown as string), "unknown");
});

test("classifyFailure precedence: usage-limit wins over a co-occurring rate word", () => {
  // A message that mentions both — the exhausted-quota response is the safe one.
  assert.equal(classifyFailure("usage limit reached; do not rate limit yourself"), "usage-limit");
});

// ---------------------------------------------------------------------------
// parseResetTime — the exact incident string, before and after the reset time
// ---------------------------------------------------------------------------

test('parseResetTime("resets 8:50pm (UTC)") BEFORE 8:50pm resolves to today 20:50 UTC', () => {
  const got = parseResetTime("Your limit resets 8:50pm (UTC).", JUL7_10AM);
  assert.equal(got, Date.UTC(2026, 6, 7, 20, 50, 0, 0));
  assert.ok(got !== null && got > JUL7_10AM);
});

test('parseResetTime("resets 8:50pm (UTC)") AFTER 8:50pm rolls to tomorrow 20:50 UTC', () => {
  const got = parseResetTime("Your limit resets 8:50pm (UTC).", JUL7_9PM);
  assert.equal(got, Date.UTC(2026, 6, 8, 20, 50, 0, 0));
  assert.ok(got !== null && got > JUL7_9PM);
});

test("parseResetTime handles a 24-hour clock (resets at HH:MM), with next-day rollover", () => {
  // 14:30 is after 10:00 → same day.
  assert.equal(parseResetTime("resets at 14:30", JUL7_10AM), Date.UTC(2026, 6, 7, 14, 30, 0, 0));
  // 08:00 is before 10:00 → rolls to next day.
  assert.equal(parseResetTime("resets at 08:00", JUL7_10AM), Date.UTC(2026, 6, 8, 8, 0, 0, 0));
});

test("parseResetTime handles 12h am/pm rollover at the 12→24 boundary", () => {
  // 12:00am is midnight (00:00) — already past 10:00 → next day 00:00.
  assert.equal(parseResetTime("resets 12:00am (UTC)", JUL7_10AM), Date.UTC(2026, 6, 8, 0, 0, 0, 0));
  // 12:15pm is noon-ish (12:15) — after 10:00 → same day.
  assert.equal(parseResetTime("resets 12:15pm (UTC)", JUL7_10AM), Date.UTC(2026, 6, 7, 12, 15, 0, 0));
});

test("parseResetTime parses ISO 8601 timestamps (with and without an explicit Z)", () => {
  assert.equal(parseResetTime("reset at 2026-07-07T20:50:00Z", JUL7_10AM), Date.UTC(2026, 6, 7, 20, 50, 0, 0));
  // Bare (tz-less) ISO is read as UTC, not host-local.
  assert.equal(parseResetTime("next window 2026-07-08T06:00", JUL7_10AM), Date.UTC(2026, 6, 8, 6, 0, 0, 0));
});

test("parseResetTime parses relative expressions anchored on nowMs", () => {
  assert.equal(parseResetTime("try again in 30 minutes", JUL7_10AM), JUL7_10AM + 30 * MIN);
  assert.equal(parseResetTime("retry in 2 hours", JUL7_10AM), JUL7_10AM + 2 * HOUR);
  assert.equal(parseResetTime("wait in 45 min", JUL7_10AM), JUL7_10AM + 45 * MIN);
  assert.equal(parseResetTime("in 90 seconds", JUL7_10AM), JUL7_10AM + 90 * 1000);
});

test("parseResetTime returns null when no time is present or input is bad", () => {
  assert.equal(parseResetTime("usage limit reached, sorry", JUL7_10AM), null);
  assert.equal(parseResetTime("", JUL7_10AM), null);
  assert.equal(parseResetTime(undefined as unknown as string, JUL7_10AM), null);
  assert.equal(parseResetTime("resets at 8:50pm", Number.NaN), null);
});

// ---------------------------------------------------------------------------
// nextWake — the actual retry decision
// ---------------------------------------------------------------------------

test("nextWake for usage-limit waits until just after a known reset (+60s pad)", () => {
  const resetAtMs = Date.UTC(2026, 6, 7, 20, 50, 0, 0);
  assert.equal(nextWake({ failure: "usage-limit", resetAtMs, nowMs: JUL7_10AM }), resetAtMs + 60_000);
});

test("nextWake for usage-limit with an unknown/past reset falls back to +30min", () => {
  assert.equal(nextWake({ failure: "usage-limit", resetAtMs: null, nowMs: JUL7_10AM }), JUL7_10AM + 30 * MIN);
  // A reset already in the past is stale — ignore it, use the fallback.
  assert.equal(
    nextWake({ failure: "usage-limit", resetAtMs: JUL7_10AM - HOUR, nowMs: JUL7_10AM }),
    JUL7_10AM + 30 * MIN,
  );
});

test("nextWake for rate-limit/overloaded grows exponentially: 2^attempt * 60s", () => {
  for (const failure of ["rate-limit", "overloaded"] as FailureKind[]) {
    assert.equal(nextWake({ failure, attempt: 0, nowMs: JUL7_10AM }), JUL7_10AM + 1 * MIN);
    assert.equal(nextWake({ failure, attempt: 1, nowMs: JUL7_10AM }), JUL7_10AM + 2 * MIN);
    assert.equal(nextWake({ failure, attempt: 2, nowMs: JUL7_10AM }), JUL7_10AM + 4 * MIN);
    assert.equal(nextWake({ failure, attempt: 5, nowMs: JUL7_10AM }), JUL7_10AM + 32 * MIN);
  }
});

test("nextWake caps exponential backoff (default 1h, and a custom cap)", () => {
  // attempt 6 → 64min, clamped to the 1h default.
  assert.equal(nextWake({ failure: "rate-limit", attempt: 6, nowMs: JUL7_10AM }), JUL7_10AM + HOUR);
  assert.equal(nextWake({ failure: "rate-limit", attempt: 20, nowMs: JUL7_10AM }), JUL7_10AM + HOUR);
  // Custom, smaller cap is honored.
  assert.equal(
    nextWake({ failure: "overloaded", attempt: 10, nowMs: JUL7_10AM, capMs: 5 * MIN }),
    JUL7_10AM + 5 * MIN,
  );
});

test("nextWake treats a missing/negative attempt as attempt 0", () => {
  assert.equal(nextWake({ failure: "rate-limit", nowMs: JUL7_10AM }), JUL7_10AM + 1 * MIN);
  assert.equal(nextWake({ failure: "rate-limit", attempt: -3, nowMs: JUL7_10AM }), JUL7_10AM + 1 * MIN);
});

test("nextWake returns null for auth and unknown (escalate, never auto-retry)", () => {
  assert.equal(nextWake({ failure: "auth", nowMs: JUL7_10AM }), null);
  assert.equal(nextWake({ failure: "unknown", nowMs: JUL7_10AM }), null);
});

// ---------------------------------------------------------------------------
// End-to-end: the incident, reconstructed
// ---------------------------------------------------------------------------

test("incident replay: usage-limit text → one wake just after the parsed reset, not 115 retries", () => {
  const errText = "Claude usage limit reached. Your limit resets 8:50pm (UTC).";
  const kind = classifyFailure(errText);
  assert.equal(kind, "usage-limit");

  const resetAtMs = parseResetTime(errText, JUL7_10AM);
  assert.equal(resetAtMs, Date.UTC(2026, 6, 7, 20, 50, 0, 0));

  const wake = nextWake({ failure: kind, resetAtMs, nowMs: JUL7_10AM });
  // Sleep ~11 hours to the reset, not a 3-hour hot loop.
  assert.equal(wake, (resetAtMs as number) + 60_000);
  assert.ok((wake as number) - JUL7_10AM > 10 * HOUR);
});
