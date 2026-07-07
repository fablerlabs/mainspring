import type { Action, Rule, Verdict } from "./rules.js";

export interface FiredRule {
  id: string;
  description: string;
  verdict: Verdict;
}

export interface GuardResult {
  verdict: Verdict;
  firedRules: FiredRule[];
}

const PRECEDENCE: Record<Verdict, number> = { allow: 0, escalate: 1, block: 2 };

/**
 * Evaluates one Action against a rule set. `block` beats `escalate` beats
 * `allow`. A rule is "fired" if it returns anything other than `allow`.
 * Never throws: a rule that throws is treated as `escalate` — governance
 * failing closed rather than the session crashing.
 */
export function evaluate(action: Action, rules: Rule[]): GuardResult {
  const firedRules: FiredRule[] = [];
  let verdict: Verdict = "allow";

  for (const rule of rules) {
    let ruleVerdict: Verdict;
    try {
      ruleVerdict = rule.test(action);
    } catch {
      ruleVerdict = "escalate";
    }

    if (ruleVerdict !== "allow") {
      firedRules.push({ id: rule.id, description: rule.description, verdict: ruleVerdict });
    }
    if (PRECEDENCE[ruleVerdict] > PRECEDENCE[verdict]) {
      verdict = ruleVerdict;
    }
  }

  return { verdict, firedRules };
}
