/**
 * Mainspring schedule contracts.
 *
 * This package answers one question, as pure logic: given the clock, a cadence,
 * and the outcome of prior sessions, *should a session run right now, and with
 * what focus?* It owns no timers, spawns no processes, and reads no files. The
 * caller passes in `now` (epoch milliseconds) and whether a STOP file exists;
 * `decide()` returns a verdict. That keeps it deterministic — the same inputs
 * always yield the same decision — so any host (cron, systemd, CI, a bare
 * `while` loop) can drive it, and every branch is trivially unit-testable.
 *
 * All time reasoning is in UTC and in epoch milliseconds. Cron fields are
 * matched against the UTC components of `now`.
 */

/**
 * How often a session should fire.
 *
 * - `interval`: a fixed gap since the last run — the simplest cadence.
 * - `cron`: a 5-field cron expression ("min hour dom month dow"), matched
 *   against the UTC wall-clock of `now`. See {@link matchesCron} for the
 *   supported subset.
 *
 * The optional `focus` is an opaque label the schedule carries through to a
 * positive {@link RunDecision} — e.g. "daily-report" or "reconcile-ledger" —
 * so a host can run different cadences for different jobs and know which one
 * fired without re-deriving it.
 */
export type Schedule =
  | { kind: "interval"; everyMs: number; focus?: string }
  | { kind: "cron"; expr: string; focus?: string };

/**
 * Exponential backoff applied after consecutive failed sessions, so a broken
 * job waits progressively longer between retries instead of hammering every
 * tick. The delay after `n` consecutive failures (n >= 1) is
 * `min(maxMs, baseMs * factor ** (n - 1))`. A successful run resets the count
 * to zero (see {@link recordResult}), which removes the backoff entirely.
 */
export interface BackoffPolicy {
  /** Delay after the first failure, in milliseconds. */
  baseMs: number;
  /** Multiplier applied per additional consecutive failure (2 = doubling). */
  factor: number;
  /** Upper bound on the computed delay, in milliseconds. */
  maxMs: number;
}

/**
 * What the scheduler remembers between ticks. It is small and serializable on
 * purpose — a host can persist it as JSON next to the workspace.
 */
export interface ScheduleState {
  /** Epoch ms when a session last *started* (attempted). Omitted if never run. */
  lastRun?: number;
  /** Failed sessions in a row since the last success. Zero when healthy. */
  consecutiveFailures: number;
}

/** Knobs for a single {@link decide} call. */
export interface DecideOptions {
  /**
   * Whether the STOP kill-switch file exists. When true, `decide` ALWAYS
   * returns `run: false`, regardless of cadence or backoff — the fail-safe.
   */
  stopFilePresent: boolean;
  /**
   * Backoff policy to apply while `consecutiveFailures > 0`. Defaults to
   * {@link DEFAULT_BACKOFF}. Pass a zero-delay policy to disable backoff.
   */
  backoff?: BackoffPolicy;
}

/** The verdict: run or not, why, and (when running) which job. */
export interface RunDecision {
  /** True only if the session should start now. */
  run: boolean;
  /** Human-readable justification — good for logs and audit trails. */
  reason: string;
  /** The schedule's `focus`, present only when `run` is true and one was set. */
  focus?: string;
}
