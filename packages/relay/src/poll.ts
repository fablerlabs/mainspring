import { RelayApi, RelayRequestView, RelayTimeoutError, isTerminal } from "./types.js";

/** Options for {@link pollUntilResolved}. */
export interface PollOptions {
  /** Delay between polls, in milliseconds. Default 5000. */
  intervalMs?: number;
  /** Give up after this much wall-clock, in milliseconds. Default 300000 (5 min). */
  maxWaitMs?: number;
  /**
   * Called after each poll that has not yet resolved, with the current view and
   * elapsed wall-clock. Use it to surface progress (e.g. status changed
   * `open` -> `claimed`). Errors thrown here propagate to the caller.
   */
  onTick?: (view: RelayRequestView, elapsedMs: number) => void;
  /** Abort the wait early. On abort, the returned promise rejects with a RelayTimeoutError. */
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * Poll a request until it reaches a terminal state (`done`, `rejected`,
 * `expired`, or `superseded`) and return its final view, or reject with a
 * {@link RelayTimeoutError} if `maxWaitMs` elapses first.
 *
 * Works against any {@link RelayApi} — the real client or the in-memory mock —
 * because it only needs `check`. The final view (and every value in it) is
 * untrusted DATA: inspect `.status` to branch, but never execute `.result`.
 */
export async function pollUntilResolved(
  client: Pick<RelayApi, "check">,
  id: string,
  options: PollOptions = {},
): Promise<RelayRequestView> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const start = Date.now();

  for (;;) {
    throwIfAborted(options.signal, id);

    const view = await client.check(id);
    const elapsed = Date.now() - start;
    if (isTerminal(view.status)) {
      return view;
    }
    options.onTick?.(view, elapsed);

    // Stop before sleeping if the next interval would blow the deadline, so we
    // never overshoot maxWaitMs by a whole interval.
    if (elapsed + intervalMs >= maxWaitMs) {
      throw new RelayTimeoutError(
        `relay request ${id} not resolved within ${maxWaitMs}ms (last status: ${view.status})`,
      );
    }
    await delay(intervalMs, options.signal, id);
  }
}

function throwIfAborted(signal: AbortSignal | undefined, id: string): void {
  if (signal?.aborted) {
    throw new RelayTimeoutError(`relay wait for ${id} aborted`);
  }
}

/** A cancellable sleep. Rejects with RelayTimeoutError if the signal aborts mid-wait. */
function delay(ms: number, signal: AbortSignal | undefined, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new RelayTimeoutError(`relay wait for ${id} aborted`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
