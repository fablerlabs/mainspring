/**
 * The seller's constitution-as-code: two governance rules an operator agent
 * cannot talk its way past. Both are ordinary `@mainspring/governance` `Rule`s
 * — the same shape, `Verdict` vocabulary, and `evaluate()` precedence the core
 * runtime uses — so the seller reuses the real governance engine rather than
 * a bespoke check.
 *
 * Seller operations are expressed as core `run` Actions so they flow through
 * governance unchanged:
 *   - a price change  → { kind: "run", tool: "set-price", args: { route, newPriceUsd } }
 *   - a refund        → { kind: "run", tool: "refund",    args: { saleId, reason, amountUsd } }
 *
 * Both rules fail CLOSED: a malformed price or a non-string reason is blocked,
 * never waved through, mirroring how the ledger's spend check refuses an amount
 * it cannot reason about.
 */
import type { Action, Rule } from "@mainspring/governance";

/** Safely view an Action's `unknown` args as a string-keyed record. */
function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

/**
 * Price cap: no endpoint may be priced above `maxPriceUsd`. A missing,
 * non-finite, or negative price is blocked (fail-closed) rather than compared
 * — the guard denies any price it cannot reason about.
 */
export function priceCapRule(maxPriceUsd: number): Rule {
  return {
    id: "price-cap",
    description: `An endpoint's price may not exceed the $${maxPriceUsd.toFixed(2)} cap.`,
    test(action: Action) {
      if (action.kind !== "run" || action.tool !== "set-price") return "allow";
      const price = asRecord(action.args).newPriceUsd;
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return "block";
      return price > maxPriceUsd ? "block" : "allow";
    },
  };
}

/**
 * Refund policy: a refund may only be issued for a reason the operator declared
 * up front. A refund with no reason, a non-string reason, or a reason absent
 * from the policy list is blocked — "refunds without a rule" never happen.
 */
export function refundPolicyRule(allowedReasons: readonly string[]): Rule {
  const allowed = new Set(allowedReasons);
  return {
    id: "refund-policy",
    description: "A refund may only be issued for a reason named in the refund policy.",
    test(action: Action) {
      if (action.kind !== "run" || action.tool !== "refund") return "allow";
      const reason = asRecord(action.args).reason;
      if (typeof reason !== "string" || reason.length === 0) return "block";
      return allowed.has(reason) ? "allow" : "block";
    },
  };
}

/** The seller's full rule set, closed over its live policy. */
export function sellerRules(policy: { maxPriceUsd: number; refundReasons: readonly string[] }): Rule[] {
  return [priceCapRule(policy.maxPriceUsd), refundPolicyRule(policy.refundReasons)];
}
