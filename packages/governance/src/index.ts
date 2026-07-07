/**
 * @mainspring/governance — constitution-as-code. Hard rules the brain cannot
 * override, loaded from CONSTITUTION.md and enforced as Action guards.
 * Zero runtime dependencies; never throws; no network.
 */

export type { Action, Verdict, Rule, MoneyCaps, GovernanceConfig } from "./rules.js";
export { createBuiltInRules, checkSpendPolicy } from "./rules.js";
export { evaluate, type FiredRule, type GuardResult } from "./guard.js";
export {
  parseHardRules,
  attachConstitutionDescriptions,
  loadConstitutionRules,
  loadConstitutionFile,
  type ParsedHardRule,
  type LoadedConstitution,
} from "./loader.js";
