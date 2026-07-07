/**
 * The decision logic: pure functions over (now, schedule, state, options).
 *
 * `decide()` is the entry point a host calls once per tick. It layers three
 * gates, checked in this order so the safest answer always wins:
 *
 *   1. STOP file      — if present, never run (fail-safe kill switch).
 *   2. Cadence        — interval elapsed, or cron matches this UTC minute.
 *   3. Backoff        — while failing, wait an exponentially growing delay.
 *
 * Nothing here reads a clock or the filesystem: `now` and `stopFilePresent`
 * are supplied by the caller, which is what makes every branch deterministic.
 */

import { matchesCron } from "./cron.js";
import type {
  BackoffPolicy,
  DecideOptions,
  RunDecision,
  Schedule,
  ScheduleState,
} from "./types.js";

const MS_PER_MINUTE = 60_000;

/** Sensible default: 1 min after the first failure, doubling, capped at 1 hour. */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 60_000,
  factor: 2,
  maxMs: 3_600_000,
};

/**
 * The backoff delay to enforce after `consecutiveFailures` failures in a row:
 * `min(maxMs, baseMs * factor ** (failures - 1))`. Returns 0 when not failing,
 * so a healthy job is never delayed. Never returns a negative number.
 */
export function backoffDelayMs(policy: BackoffPolicy, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const raw = policy.baseMs * policy.factor ** (consecutiveFailures - 1);
  return Math.max(0, Math.min(policy.maxMs, raw));
}

/** Whether the cadence alone says "go", plus a reason string either way. */
function cadence(
  now: number,
  schedule: Schedule,
  lastRun: number | undefined,
): { due: boolean; reason: string } {
  if (schedule.kind === "interval") {
    if (lastRun === undefined) {
      return { due: true, reason: "interval: first run" };
    }
    const elapsed = now - lastRun;
    if (elapsed >= schedule.everyMs) {
      return { due: true, reason: `interval: ${elapsed}ms elapsed >= ${schedule.everyMs}ms` };
    }
    return { due: false, reason: `interval: next run in ${schedule.everyMs - elapsed}ms` };
  }

  // cron — matchesCron throws CronParseError on a malformed expression, which
  // decide() catches and turns into a fail-safe "do not run".
  if (!matchesCron(schedule.expr, now)) {
    return { due: false, reason: `cron "${schedule.expr}": not due this minute` };
  }
  // Guard against firing twice within the same matching minute.
  const minuteStart = Math.floor(now / MS_PER_MINUTE) * MS_PER_MINUTE;
  if (lastRun !== undefined && lastRun >= minuteStart) {
    return { due: false, reason: `cron "${schedule.expr}": already ran this minute` };
  }
  return { due: true, reason: `cron "${schedule.expr}": matches now` };
}

/**
 * Decide whether a session should run at `now`.
 *
 * Never runs before the cadence is due, never runs while backing off, and
 * ALWAYS returns `run: false` when the STOP file is present — the STOP check
 * comes first and short-circuits everything, so a kill switch can never be
 * overridden by a due schedule or a cleared backoff.
 */
export function decide(
  now: number,
  schedule: Schedule,
  state: ScheduleState,
  opts: DecideOptions,
): RunDecision {
  // 1. Kill switch — highest priority, fail-safe.
  if (opts.stopFilePresent) {
    return { run: false, reason: "STOP file present — kill switch engaged" };
  }

  // 2. Cadence gate.
  let cad: { due: boolean; reason: string };
  try {
    cad = cadence(now, schedule, state.lastRun);
  } catch (err) {
    // A malformed cron expression must not crash the host or, worse, cause a
    // run; treat it as "not due" and surface why.
    return { run: false, reason: `invalid schedule: ${(err as Error).message}` };
  }
  if (!cad.due) {
    return { run: false, reason: cad.reason };
  }

  // 3. Backoff gate — only while there is a failure streak to serve.
  if (state.consecutiveFailures > 0 && state.lastRun !== undefined) {
    const policy = opts.backoff ?? DEFAULT_BACKOFF;
    const delay = backoffDelayMs(policy, state.consecutiveFailures);
    const readyAt = state.lastRun + delay;
    if (now < readyAt) {
      return {
        run: false,
        reason: `backing off after ${state.consecutiveFailures} failure(s); retry in ${readyAt - now}ms`,
      };
    }
  }

  // Cleared to run.
  const decision: RunDecision = { run: true, reason: cad.reason };
  if (schedule.focus !== undefined) decision.focus = schedule.focus;
  return decision;
}

/**
 * Fold the outcome of a session into the state for the next tick. A session
 * always updates `lastRun` to when it started (`now`); a success clears the
 * failure streak, a failure grows it by one (which is what backoff feeds on).
 */
export function recordResult(
  state: ScheduleState,
  outcome: { now: number; success: boolean },
): ScheduleState {
  return {
    lastRun: outcome.now,
    consecutiveFailures: outcome.success ? 0 : state.consecutiveFailures + 1,
  };
}

/** A fresh state for a schedule that has never run. */
export function initialState(): ScheduleState {
  return { consecutiveFailures: 0 };
}
