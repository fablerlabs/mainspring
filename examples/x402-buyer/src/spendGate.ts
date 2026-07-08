/**
 * The x402 spendGate: two `@mainspring/governance` Rules that gate a
 * proposed `x402-buy` purchase before any money moves. Built as ordinary
 * governance Rules (not a bespoke check) so they compose with the built-in
 * rule set via the same `evaluate()` the rest of Mainspring uses — a
 * purchase that fires one is blocked and cited by rule id, exactly like
 * `honesty-disclosure` or `no-secrets` in the other examples.
 */
import type { Action, Rule, Verdict } from "@mainspring/governance";

/** Money policy for x402 micro-purchases. Deliberately tiny — this is a data-buying agent, not the business's whole budget. */
export interface X402SpendCaps {
  /** A single purchase strictly above this is blocked outright, no matter the day's remaining budget. */
  perActionUsd: number;
  /** Today's cumulative x402 spend (already-settled + this purchase) may not exceed this. */
  dailyUsd: number;
}

/** The one Action shape this gate understands: a `run` action naming the `x402-buy` tool, price attached from the 402 challenge. */
export interface X402BuyArgs {
  url: string;
  priceUsd: number;
}

export const X402_BUY_TOOL = "x402-buy";

function extractPriceUsd(action: Action): number | null {
  if (action.kind !== "run" || action.tool !== X402_BUY_TOOL) return null;
  const args = action.args as Partial<X402BuyArgs> | null;
  const price = args?.priceUsd;
  return typeof price === "number" ? price : NaN;
}

/** Rule: a single x402 purchase may not exceed the per-action cap. Also fails closed on a non-finite/non-positive price. */
export function perActionCapRule(caps: X402SpendCaps): Rule {
  return {
    id: "x402-per-action-cap",
    description: `A single x402 purchase may not exceed the per-action cap of $${caps.perActionUsd.toFixed(2)}.`,
    test(action): Verdict {
      const priceUsd = extractPriceUsd(action);
      if (priceUsd === null) return "allow";
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return "block";
      return priceUsd > caps.perActionUsd ? "block" : "allow";
    },
  };
}

/**
 * Rule: today's cumulative x402 spend, including this purchase, may not
 * exceed the daily cap. `spentTodayUsd` is a thunk (not a snapshot) so it
 * always reads the buyer loop's running total at the moment each action is
 * evaluated, not the total from when the rule set was built.
 */
export function dailyCapRule(caps: X402SpendCaps, spentTodayUsd: () => number): Rule {
  return {
    id: "x402-daily-cap",
    description: `Today's total x402 spend may not exceed the daily cap of $${caps.dailyUsd.toFixed(2)}.`,
    test(action): Verdict {
      const priceUsd = extractPriceUsd(action);
      if (priceUsd === null) return "allow";
      // A non-finite/non-positive price is already blocked by perActionCapRule; don't double-report it here.
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return "allow";
      return spentTodayUsd() + priceUsd > caps.dailyUsd ? "block" : "allow";
    },
  };
}

/** Builds both spendGate rules for `caps`, closing over the buyer loop's live running total. */
export function x402SpendGateRules(caps: X402SpendCaps, spentTodayUsd: () => number): Rule[] {
  return [perActionCapRule(caps), dailyCapRule(caps, spentTodayUsd)];
}
