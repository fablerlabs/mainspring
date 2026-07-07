/**
 * Spend gate — the policy-tier money check the session loop runs on every
 * gate-allowed Action before dispatch.
 *
 * gate.ts already enforces the constitution's HARD per-session ceiling
 * (`moneyCaps.perSessionUsd`): a spend past it is structurally blocked and
 * never reaches here. This module adds the *tiered* check the constitution's
 * Money rule spells out — under `autoApproveUnder` proceed, in the notify band
 * proceed but tell the owner, at/above `approvalCodeOver` require the owner's
 * approval code first. It reuses `@mainspring/ledger`'s `checkSpend` for that
 * classification rather than re-deriving the bands, and records every spend
 * attempt — allow or deny — in the same audit shape `@mainspring/broker` uses,
 * so a downstream reader sees one consistent money trail.
 *
 * Fail-CLOSED throughout (matching gate.ts's structural guards): a spend whose
 * amount is missing, non-finite (NaN/Infinity), or negative is BLOCKED — never
 * silently classified as "proceed" — and a needs-approval spend without a
 * present approval code is BLOCKED. The approval gate is a ceiling, not a
 * suggestion. Pure logic: the classifier is deterministic in its inputs and the
 * only impurity (a timestamp) is injected as a clock, matching the broker.
 */
import { DEFAULT_SPEND_POLICY, checkSpend, type SpendDecision, type SpendPolicy } from "@mainspring/ledger";
import type { Action } from "./types.js";

/**
 * What the spend gate decides for one Action:
 *  - "allow"  — no spend, or a within-threshold spend: dispatch it.
 *  - "notify" — a notify-band spend: dispatch it, but the owner is owed a heads-up.
 *  - "block"  — a needs-approval spend with no approval code, or a malformed
 *               amount: do NOT dispatch (fail-closed).
 */
export type SpendGateStatus = "allow" | "notify" | "block";

/**
 * One line of the spend gate's audit trail — deliberately shaped like
 * `@mainspring/broker`'s `AuditEntry` (timestamp/capability/op/amountUsd/
 * allowed/reason) so both money boundaries write a uniform record. `decision`
 * carries the ledger `checkSpend` tier, or "invalid" when the amount failed
 * the fail-closed guard before any tier could be assigned.
 */
export interface SpendAudit {
  timestamp: string;
  /** Always "spend" — this gate governs exactly the money-out capability. */
  capability: "spend";
  /** Short label for the spend, carried verbatim: the ledger line's description or the run tool's name. */
  op: string;
  /** The classified amount. Omitted only when the raw amount was non-numeric (so there is nothing meaningful to record). */
  amountUsd?: number;
  allowed: boolean;
  reason: string;
  decision: SpendDecision | "invalid";
}

export interface SpendGateDecision {
  status: SpendGateStatus;
  /**
   * The audit entry for this Action, or `null` when the Action carries no
   * spend at all (a write, a notify, a revenue ledger line, a run with no
   * amount): the gate is a no-op for those and records nothing.
   */
  audit: SpendAudit | null;
  reason: string;
}

export interface SpendGateOptions {
  /** Threshold policy. Defaults to the constitution's bands (under $25 / $25–75 / $75+). */
  policy?: SpendPolicy;
  /**
   * Whether a valid owner approval code is present this session. A
   * needs-approval spend proceeds only when this is true; the default (false)
   * means such a spend is BLOCKED fail-closed.
   */
  approvalCodePresent?: boolean;
  /** ISO timestamp stamped into the audit entry. Injected so the classifier stays pure. */
  now: string;
}

/**
 * Pulls the spend amount an Action carries, or `null` when it carries none.
 * Two Actions can move money out:
 *  - a `ledger` line of type "expense" (revenue/refund/adjustment are pure
 *    bookkeeping and move no money outward — mirrors gate.ts and dispatch.ts);
 *  - a `run` Action whose args object carries an `amountUsd` field — the
 *    "Brain-proposed spend action" (e.g. a `stripe.charge` tool). The presence
 *    of the field, not its validity, is what marks it a spend: a bad value
 *    still routes through the gate and is blocked there, never waved past.
 * Returns the raw (unchecked) value so the caller can apply the fail-closed guard.
 */
function rawSpendField(action: Action): { op: string; raw: unknown } | null {
  switch (action.kind) {
    case "ledger":
      if (action.entry.type !== "expense") return null;
      return { op: action.entry.description, raw: action.entry.amountUsd };
    case "run": {
      const args = action.args;
      if (typeof args === "object" && args !== null && "amountUsd" in args) {
        return { op: action.tool, raw: (args as Record<string, unknown>).amountUsd };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Classifies one Action's spend (if any) against a policy. Pure: same inputs,
 * same decision and audit entry. The session loop calls this via `SpendGate`
 * (below), which supplies the clock and accumulates the audit trail.
 */
export function classifySpend(action: Action, options: SpendGateOptions): SpendGateDecision {
  const field = rawSpendField(action);
  if (field === null) {
    return { status: "allow", audit: null, reason: "action carries no spend amount" };
  }

  const policy = options.policy ?? DEFAULT_SPEND_POLICY;
  const base = { timestamp: options.now, capability: "spend" as const, op: field.op };
  const amount = typeof field.raw === "number" ? field.raw : Number.NaN;

  // Fail-closed guard (matches gate.ts's finite-number check on ledger amounts):
  // a spend must be a finite, non-negative number, or it is blocked outright.
  if (!Number.isFinite(amount) || amount < 0) {
    const reason = `spend amount ${JSON.stringify(field.raw)} is not a finite non-negative number; blocked fail-closed`;
    return {
      status: "block",
      // Only record a numeric amount; a non-numeric raw (NaN here) has nothing meaningful to log.
      audit: { ...base, ...(Number.isFinite(amount) ? { amountUsd: amount } : {}), allowed: false, reason, decision: "invalid" },
      reason,
    };
  }

  const decision = checkSpend(amount, policy);
  switch (decision) {
    case "proceed": {
      const reason = `spend of $${amount} is under the auto-approve threshold ($${policy.autoApproveUnder}); proceeds`;
      return { status: "allow", audit: { ...base, amountUsd: amount, allowed: true, reason, decision }, reason };
    }
    case "notify": {
      const reason = `spend of $${amount} is in the notify band ($${policy.autoApproveUnder}–$${policy.approvalCodeOver}); proceeds, but the owner must be notified`;
      return { status: "notify", audit: { ...base, amountUsd: amount, allowed: true, reason, decision }, reason };
    }
    case "needs-approval": {
      if (options.approvalCodePresent) {
        const reason = `spend of $${amount} needs the owner's approval code (>= $${policy.approvalCodeOver}); an approval code is present, so it proceeds`;
        return { status: "allow", audit: { ...base, amountUsd: amount, allowed: true, reason, decision }, reason };
      }
      const reason = `spend of $${amount} needs the owner's approval code (>= $${policy.approvalCodeOver}) and none is present; BLOCKED fail-closed`;
      return { status: "block", audit: { ...base, amountUsd: amount, allowed: false, reason, decision }, reason };
    }
  }
}

/**
 * Stateful spend gate: wraps `classifySpend` with a clock and an append-only
 * audit trail, mirroring `@mainspring/broker`'s `Broker`. Construct one per
 * session, call `check()` on each gate-allowed Action before dispatching it,
 * and read `audit` for the full money trail at session end.
 */
export class SpendGate {
  readonly #policy: SpendPolicy;
  readonly #approvalCodePresent: boolean;
  readonly #clock: () => Date;
  readonly #audit: SpendAudit[] = [];

  constructor(options: { policy?: SpendPolicy; approvalCodePresent?: boolean; clock?: () => Date } = {}) {
    this.#policy = options.policy ?? DEFAULT_SPEND_POLICY;
    this.#approvalCodePresent = options.approvalCodePresent ?? false;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** The spend audit trail so far, oldest first. A frozen copy — mutating it cannot affect the gate's record. */
  get audit(): readonly SpendAudit[] {
    return Object.freeze(this.#audit.slice());
  }

  /**
   * Classifies one Action and, when it IS a spend (allow, notify, or block),
   * appends exactly one audit entry. A non-spend Action records nothing and
   * always returns "allow". Never throws.
   */
  check(action: Action): SpendGateDecision {
    const decision = classifySpend(action, {
      policy: this.#policy,
      approvalCodePresent: this.#approvalCodePresent,
      now: this.#clock().toISOString(),
    });
    if (decision.audit) {
      this.#audit.push(Object.freeze(decision.audit));
    }
    return decision;
  }
}
