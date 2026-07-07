/**
 * Provider-limit-aware backoff.
 *
 * Motivating incident: on 2026-07-07 the host plan's session limit was
 * exhausted and a naive supervisor retried the agent **115 times in 3 hours**
 * — a hot-retry loop that burned quota and money while accomplishing nothing,
 * because the underlying condition (a plan reset at a fixed wall-clock time)
 * could not clear until a specific future moment.
 *
 * The fix a supervisor/agent loop actually needs is small: given a failure's
 * error text, (a) decide *what kind* of failure it is, (b) if the provider
 * told us when it resets, parse that, and (c) compute a single **wake-at**
 * epoch — or decide not to auto-retry at all (auth failures need a human).
 *
 * Everything here is a pure function. There is no `Date.now()` inside — the
 * current time (`nowMs`) is always injected, so behavior is fully
 * deterministic and unit-testable without clocks, timers, or the network.
 */

/**
 * The classes of failure a retry loop needs to tell apart. They differ in the
 * *right response*, which is the only reason to distinguish them:
 *
 * - `usage-limit`  — plan/quota/credit exhausted. Clears at a wall-clock reset,
 *                    not by retrying sooner. Wake at (or just after) the reset.
 * - `rate-limit`   — too many requests too fast. Clears quickly; back off
 *                    exponentially and retry.
 * - `overloaded`   — the provider is over capacity (transient server-side).
 *                    Same treatment as `rate-limit`: exponential backoff.
 * - `auth`         — bad/expired/missing credentials. A retry can never fix
 *                    this; a human must. Do NOT auto-retry — escalate.
 * - `unknown`      — unrecognized. Fail safe: treat like `auth` (don't guess a
 *                    retry that might hammer a hard error); escalate.
 */
export type FailureKind = "usage-limit" | "rate-limit" | "auth" | "overloaded" | "unknown";

/** Substring signals per class, checked case-insensitively. Order of the
 * checks in {@link classifyFailure} encodes precedence; see there. */
const USAGE_LIMIT_SIGNALS = [
  "usage limit",
  "session limit",
  "monthly limit",
  "daily limit",
  "plan limit",
  "quota",
  "insufficient credit",
  "insufficient_credit",
  "out of credit",
  "no credit",
  "run out of",
  "billing",
] as const;

const AUTH_SIGNALS = [
  "unauthorized",
  "authentication",
  "authenticate",
  "invalid api key",
  "invalid_api_key",
  "invalid x-api-key",
  "permission denied",
  "forbidden",
  "401",
  "403",
  "not logged in",
  "please log in",
  "please login",
  "expired token",
  "invalid token",
  "credential",
] as const;

const RATE_LIMIT_SIGNALS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "429",
  "slow down",
] as const;

const OVERLOADED_SIGNALS = [
  "overloaded",
  "overload",
  "over capacity",
  "at capacity",
  "503",
  "service unavailable",
  "temporarily unavailable",
  "try again later",
] as const;

/**
 * Classify provider error text into a {@link FailureKind}.
 *
 * Case-insensitive and resilient to non-string / empty input (→ `"unknown"`).
 * Matching is by substring against curated signal lists rather than a single
 * regex, so partial/wrapped messages (an SDK that prefixes "Error: ...", a log
 * line, a JSON body) still classify.
 *
 * Precedence when a message trips more than one class: usage-limit → auth →
 * rate-limit → overloaded. The rationale:
 * - usage-limit first because it has the most specific, least-ambiguous
 *   signals ("usage limit", "quota") and the highest cost of getting wrong
 *   (hot-retrying an exhausted plan is exactly the incident this exists for).
 * - auth before the transient classes because an auth failure must never be
 *   auto-retried; if a message somehow reads as both, fail toward the human.
 */
export function classifyFailure(text: unknown): FailureKind {
  if (typeof text !== "string" || text.length === 0) return "unknown";
  const s = text.toLowerCase();
  const has = (signals: readonly string[]): boolean => signals.some((n) => s.includes(n));

  if (has(USAGE_LIMIT_SIGNALS)) return "usage-limit";
  if (has(AUTH_SIGNALS)) return "auth";
  if (has(RATE_LIMIT_SIGNALS)) return "rate-limit";
  if (has(OVERLOADED_SIGNALS)) return "overloaded";
  return "unknown";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Extract a reset moment (epoch ms) from provider error text, or `null` if the
 * text names no time we can parse. `nowMs` is injected and used as the anchor
 * for clock-only and relative expressions.
 *
 * Recognized shapes, in the order they're tried:
 *  1. Relative — "in 30 minutes", "in 2 hours", "in 45 min", "in 90s".
 *  2. ISO 8601 — "2026-07-07T20:50:00Z" (a bare, tz-less ISO is read as UTC).
 *  3. Clock    — "resets 8:50pm (UTC)", "resets at 20:50", "8:50 am". 12-hour
 *                clocks are normalized to 24-hour. The time is placed on the
 *                UTC calendar day of `nowMs`; if that instant is already at or
 *                past `nowMs`, it rolls to the next day (the reset is in the
 *                future — this is the "resets 8:50pm" seen *after* 8:50pm case).
 *
 * All clock handling is UTC. Provider limit messages that print a wall-clock
 * time annotate it "(UTC)"; assuming UTC keeps this deterministic and avoids a
 * host-timezone dependency.
 */
export function parseResetTime(text: unknown, nowMs: number): number | null {
  if (typeof text !== "string" || text.length === 0) return null;
  if (!Number.isFinite(nowMs)) return null;

  // 1. Relative: "in N <unit>" — anchored on nowMs.
  const rel = text.match(/\bin\s+(\d+(?:\.\d+)?)\s*(sec(?:ond)?s?|min(?:ute)?s?|hr?s?|hours?)\b/i);
  if (rel) {
    const n = Number.parseFloat(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = unit.startsWith("s") ? 1000 : unit.startsWith("h") ? HOUR_MS : MINUTE_MS;
    return nowMs + n * mult;
  }

  // 2. ISO 8601 timestamp. Read on the original text (case-sensitive T/Z).
  const iso = text.match(/\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    let stamp = iso[0].replace(" ", "T");
    const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(stamp);
    if (!hasTz) stamp += "Z"; // a bare ISO is interpreted as UTC, not host-local
    const ms = Date.parse(stamp);
    if (!Number.isNaN(ms)) return ms;
  }

  // 3. Clock time, optionally with am/pm — placed on nowMs's UTC day.
  const clock = text.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (clock) {
    let hour = Number.parseInt(clock[1], 10);
    const minute = Number.parseInt(clock[2], 10);
    if (hour > 23 || minute > 59) return null;
    const ap = clock[3] ? clock[3].replace(/\./g, "").toLowerCase() : "";
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    if (ap === "pm" && hour === 12) hour = 12; // noon stays 12

    const d = new Date(nowMs);
    let candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
    if (candidate <= nowMs) candidate += DAY_MS; // already past today → next day
    return candidate;
  }

  return null;
}

/** Small pad added after a usage-limit reset so we wake a beat *after* the
 * provider flips the switch, never a beat before (which would just re-fail). */
const USAGE_RESET_PAD_MS = 60_000;
/** Fallback wait for a usage-limit whose reset time we couldn't parse. */
const USAGE_UNKNOWN_WAIT_MS = 30 * MINUTE_MS;
/** Base unit for exponential backoff: attempt 0 → 60s. */
const BACKOFF_BASE_MS = MINUTE_MS;
/** Default ceiling for exponential backoff. */
const DEFAULT_CAP_MS = HOUR_MS;

export interface NextWakeInput {
  /** The classified failure (see {@link classifyFailure}). */
  failure: FailureKind;
  /** Parsed reset time (see {@link parseResetTime}), if any. Only consulted
   * for `usage-limit`. A past/invalid value is ignored in favor of the
   * unknown-reset fallback. */
  resetAtMs?: number | null;
  /** Zero-based retry attempt, driving exponential backoff for the transient
   * classes. Defaults to 0. Negative/non-finite values are clamped to 0. */
  attempt?: number;
  /** Injected current time. */
  nowMs: number;
  /** Ceiling for exponential backoff. Defaults to 1 hour. */
  capMs?: number;
}

/**
 * Compute the next **wake-at** epoch (ms), or `null` meaning "do not auto-retry
 * — escalate to a human". This is the one function a supervisor loop calls
 * after a failure: sleep until the returned instant, or, on `null`, stop and
 * page a human.
 *
 * Policy by class:
 * - `usage-limit` → `resetAtMs + 60s` when a future reset is known; otherwise
 *   `nowMs + 30min`. (No retrying before the plan actually resets.)
 * - `rate-limit` / `overloaded` → exponential: `nowMs + min(2^attempt * 60s,
 *   capMs)`. Transient and self-clearing.
 * - `auth` / `unknown` → `null`. A retry cannot fix a credential problem, and
 *   we refuse to guess a retry for something we didn't recognize.
 */
export function nextWake(input: NextWakeInput): number | null {
  const { failure, resetAtMs, nowMs } = input;
  const capMs = input.capMs ?? DEFAULT_CAP_MS;
  const attempt = Number.isFinite(input.attempt) ? Math.max(0, Math.floor(input.attempt as number)) : 0;

  switch (failure) {
    case "usage-limit": {
      if (typeof resetAtMs === "number" && Number.isFinite(resetAtMs) && resetAtMs > nowMs) {
        return resetAtMs + USAGE_RESET_PAD_MS;
      }
      return nowMs + USAGE_UNKNOWN_WAIT_MS;
    }
    case "rate-limit":
    case "overloaded": {
      const backoff = Math.min(2 ** attempt * BACKOFF_BASE_MS, Math.max(0, capMs));
      return nowMs + backoff;
    }
    case "auth":
    case "unknown":
    default:
      return null;
  }
}
