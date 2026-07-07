/**
 * @mainspring/ledger — the money module: append-only LEDGER.csv management
 * with balance invariants and spend-cap thresholds. Zero runtime
 * dependencies; no LLM calls; no network.
 */

export {
  Ledger,
  LedgerInvariantError,
  LEDGER_CSV_HEADER,
  ledgerPath,
  readLedger,
  appendLedger,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerRow,
} from "./ledger.js";
export { DEFAULT_SPEND_POLICY, checkSpend, type SpendPolicy, type SpendDecision } from "./caps.js";
