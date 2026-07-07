/**
 * Spend caps: the constitution's money-approval thresholds as a pure
 * function. No filesystem, no network — just "given this policy, what does
 * this spend require before it happens."
 *
 * Boundaries are inclusive on the stricter side: a spend exactly at a
 * threshold gets the more cautious outcome (e.g. exactly `approvalCodeOver`
 * needs approval, not just "notify"). Money code should never round in its
 * own favor.
 */

export interface SpendPolicy {
  /** Spend strictly below this proceeds with no owner involvement. */
  autoApproveUnder: number;
  /** Spend strictly below this (and at/above `autoApproveUnder`) notifies the owner but proceeds. */
  notifyUnder: number;
  /** Spend at/above this requires the owner's approval code before it proceeds. */
  approvalCodeOver: number;
}

export type SpendDecision = "proceed" | "notify" | "needs-approval";

/** The constitution's defaults: under $25 proceed, $25–75 notify, $75+ needs the approval code. */
export const DEFAULT_SPEND_POLICY: SpendPolicy = {
  autoApproveUnder: 25,
  notifyUnder: 75,
  approvalCodeOver: 75,
};

/**
 * Classifies one spend under a policy. `approvalCodeOver` always wins if
 * reached, even for a policy where `notifyUnder` is set lower — the
 * approval-code gate is the hard ceiling, not a suggestion.
 */
export function checkSpend(amountUsd: number, policy: SpendPolicy = DEFAULT_SPEND_POLICY): SpendDecision {
  if (amountUsd >= policy.approvalCodeOver) return "needs-approval";
  if (amountUsd >= policy.autoApproveUnder || amountUsd >= policy.notifyUnder) return "notify";
  return "proceed";
}
