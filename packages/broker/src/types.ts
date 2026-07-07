/**
 * Generalizes docs/broker/SPEC.md's credential-broker design (root-owned
 * binaries, sudoers-gated, per-op caps, append-only audit log) into a
 * model-agnostic shape: any side effect a brain wants (spend, message,
 * publish, ...) is a `Capability` registered once with a `Cap`, then
 * exercised only through `Broker#request` — see `broker.ts`.
 */

/** Per-capability limits, checked before a request is ever handed to its handler. */
export interface Cap {
  /** A single request's `amountUsd` may not exceed this. Omit for capabilities with no dollar amount. */
  maxAmountUsd?: number;
  /** Requests actually serviced (checks passed) may not exceed this many in one UTC calendar day. */
  maxCallsPerDay: number;
  /**
   * If set, a request must carry a `target` present in this list (e.g. the
   * one owner chat id, a fixed set of product names). Omitting `target` on a
   * request against an allowlisted capability is a deny, not a wildcard.
   */
  allowlist?: string[];
}

/** One side-effect capability the broker can be asked to exercise. */
export interface Capability {
  /** Unique within a Broker instance, e.g. "spend", "notify-owner". */
  id: string;
  description: string;
  cap: Cap;
}

/** One ask against a registered capability. */
export interface BrokerRequest {
  capability: string;
  /** A short label for what's being done, e.g. "vps-hosting" or "product-create" — carried into the audit log verbatim. */
  op: string;
  /** The specific recipient/resource this request targets, checked against `Cap.allowlist` when the capability declares one. */
  target?: string;
  amountUsd?: number;
  args?: Record<string, unknown>;
}

export interface BrokerResult {
  allowed: boolean;
  /** Why the request was allowed or denied — "ok" on success, a specific reason otherwise. */
  reason: string;
  /** The handler's return value. Present only when `allowed` is true and the handler didn't throw. */
  output?: unknown;
}

/** One line of the append-only audit trail: every attempt, allow or deny. */
export interface AuditEntry {
  timestamp: string;
  capability: string;
  op: string;
  target?: string;
  amountUsd?: number;
  allowed: boolean;
  reason: string;
  /** UTC calendar day (`YYYY-MM-DD`) the request fell on — the unit `Cap.maxCallsPerDay` resets on. */
  dayKey: string;
  /** This capability's 1-based count of serviced requests on `dayKey`, including this one. Absent when the request was denied before being counted. */
  callIndexToday?: number;
}

/** Handles one already-authorized request. Throwing denies the result but the attempt is still audited (and still counts against the day's cap — it was authorized to run). */
export type CapabilityHandler = (req: BrokerRequest) => unknown | Promise<unknown>;
