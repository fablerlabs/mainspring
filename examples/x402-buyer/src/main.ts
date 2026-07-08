/**
 * x402-buyer: a mainspring agent whose spendGate governs real x402
 * micro-purchases before they happen.
 *
 *   @mainspring/governance — createBuiltInRules() + the local spendGate
 *                             Rules, evaluate() gates every proposed buy
 *   @mainspring/ledger     — appendLedger()/readLedger(), the
 *                             invariant-checked LEDGER.csv
 *
 * The loop proposes a `buy` for each URL on its shopping list, probes the
 * x402 resource for its 402 challenge (free), runs the price through the
 * spendGate, and only pays + records a ledger expense if the gate allows
 * it. A purchase that would exceed the per-action or daily cap is blocked
 * before `pay()` is ever called — cited by the specific rule that fired,
 * not just silently skipped. No network, no secrets, no real spend: the
 * transport is a canned mock (see x402.ts for the seam a real client
 * drops into).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachConstitutionDescriptions,
  createBuiltInRules,
  evaluate,
  parseHardRules,
  type Action,
  type FiredRule,
  type Verdict,
} from "@mainspring/governance";
import { appendLedger, readLedger } from "@mainspring/ledger";
import { dailyCapRule, perActionCapRule, X402_BUY_TOOL, type X402SpendCaps } from "./spendGate.js";
import { MockX402Transport, type X402Transport } from "./x402.js";

export const CONSTITUTION_MD = `# CONSTITUTION — x402-Buyer Example Business

## Mission
Buy small, useful data resources over x402, on a strict per-purchase and
daily budget, never spending a cent the spendGate hasn't cleared first.

## Hard rules
1. Legal and honest only.
2. Secrets never appear in a write, notification, or tool call. <!-- rule:no-secrets -->
3. Only pre-approved tools may be called from a session. <!-- rule:external-allowlist -->
4. A single x402 purchase may never exceed the per-action cap. <!-- rule:x402-per-action-cap -->
5. Today's total x402 spend may never exceed the daily cap. <!-- rule:x402-daily-cap -->
`;

/** Deliberately tiny: this is a data-buying agent's micro-budget, not the whole business's. */
export const X402_SPEND_CAPS: X402SpendCaps = {
  perActionUsd: 2.0,
  dailyUsd: 5.0,
};

const ALLOWED_TOOLS = [X402_BUY_TOOL];

/** The canned x402 catalog this example's mock transport serves. Real prices a real merchant might charge for small data resources. */
const CATALOG = {
  "https://data.example/eod-report": { priceUsd: 0.4, payTo: "0xMerchant.eod", body: "EOD market report CSV\n" },
  "https://data.example/sentiment-snippet": { priceUsd: 0.35, payTo: "0xMerchant.sentiment", body: "Sentiment snippet JSON\n" },
  "https://data.example/full-history-dump": { priceUsd: 3.5, payTo: "0xMerchant.history", body: "Full history dump\n" },
  "https://data.example/weekly-digest": { priceUsd: 1.8, payTo: "0xMerchant.digest", body: "Weekly digest PDF\n" },
  "https://data.example/macro-outlook": { priceUsd: 1.9, payTo: "0xMerchant.macro", body: "Macro outlook PDF\n" },
  "https://data.example/another-report": { priceUsd: 0.8, payTo: "0xMerchant.another", body: "Another report\n" },
};

/**
 * The shopping list, in order. Isolates both block reasons cleanly (with a
 * $2.00 per-action cap and a $5.00 daily cap):
 *   1. eod-report            $0.40  -> allowed  (running total $0.40)
 *   2. sentiment-snippet     $0.35  -> allowed  (running total $0.75)
 *   3. full-history-dump     $3.50  -> BLOCKED  (exceeds the $2.00 per-action cap; would've been $4.25 running, still under the daily cap — this is a per-action-only block)
 *   4. weekly-digest         $1.80  -> allowed  (running total $2.55)
 *   5. macro-outlook         $1.90  -> allowed  (running total $4.45)
 *   6. another-report        $0.80  -> BLOCKED  (within the $2.00 per-action cap alone, but $4.45 + $0.80 > the $5.00 daily cap — a daily-only block)
 */
export const PURCHASE_PLAN: string[] = [
  "https://data.example/eod-report",
  "https://data.example/sentiment-snippet",
  "https://data.example/full-history-dump",
  "https://data.example/weekly-digest",
  "https://data.example/macro-outlook",
  "https://data.example/another-report",
];

export interface PurchaseTrace {
  url: string;
  priceUsd: number;
  verdict: Verdict;
  firedRules: FiredRule[];
  applied: boolean;
  detail: string;
}

export interface X402BuyerResult {
  workspaceDir: string;
  purchases: PurchaseTrace[];
  ledgerBalanceUsd: number;
  spentTodayUsd: number;
}

/**
 * Runs the buyer loop against `workspaceDir`: for each URL, probe -> gate ->
 * (pay + ledger) or (blocked, cited). `transport` is injected so tests (and
 * a future real deployment) can swap in a different implementation without
 * touching this function.
 */
export async function runX402Buyer(
  workspaceDir: string,
  transport: X402Transport,
  urls: string[] = PURCHASE_PLAN,
  caps: X402SpendCaps = X402_SPEND_CAPS,
): Promise<X402BuyerResult> {
  let spentTodayUsd = 0;
  const rules = attachConstitutionDescriptions(
    [...createBuiltInRules({ allowedTools: ALLOWED_TOOLS }), perActionCapRule(caps), dailyCapRule(caps, () => spentTodayUsd)],
    parseHardRules(CONSTITUTION_MD),
  );

  const purchases: PurchaseTrace[] = [];

  for (const url of urls) {
    const challenge = await transport.probe(url);
    const action: Action = { kind: "run", tool: X402_BUY_TOOL, args: { url, priceUsd: challenge.priceUsd } };
    const { verdict, firedRules } = evaluate(action, rules);

    let applied = false;
    let detail: string;

    if (verdict === "allow") {
      const receipt = await transport.pay(challenge);
      const row = await appendLedger(workspaceDir, {
        date: new Date().toISOString(),
        type: "expense",
        description: `x402 purchase: ${url} (receipt ${receipt.receiptId})`,
        amountUsd: challenge.priceUsd,
      });
      // Derived from the ledger's own (cent-rounded) balance rather than accumulated locally,
      // so repeated float addition here can't drift away from what LEDGER.csv actually records.
      spentTodayUsd = -row.balanceUsd;
      applied = true;
      detail = `paid $${challenge.priceUsd.toFixed(2)}, ledger balance now $${row.balanceUsd.toFixed(2)}`;
    } else {
      // Blocked before `transport.pay()` is ever called — cited by the specific rule that fired, not a generic refusal.
      detail = firedRules.map((r) => `${r.id} (${r.verdict}): ${r.description}`).join(" | ");
    }

    purchases.push({ url, priceUsd: challenge.priceUsd, verdict, firedRules, applied, detail });
  }

  const ledger = await readLedger(workspaceDir);

  return { workspaceDir, purchases, ledgerBalanceUsd: ledger.balance(), spentTodayUsd };
}

function printTrace(result: X402BuyerResult): void {
  console.log(`Mainspring x402-buyer — workspace: ${result.workspaceDir}\n`);
  for (const p of result.purchases) {
    const mark = p.verdict === "allow" ? "✓ ALLOWED" : `✗ ${p.verdict.toUpperCase()}`;
    console.log(`  ${mark}  $${p.priceUsd.toFixed(2)}  ${p.url}`);
    console.log(`      ${p.detail}`);
  }
  console.log(`\nSpent today: $${result.spentTodayUsd.toFixed(2)}`);
  console.log(`Ledger balance: $${result.ledgerBalanceUsd.toFixed(2)}`);
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-x402-buyer-"));
  const transport = new MockX402Transport(CATALOG);
  const result = await runX402Buyer(workspaceDir, transport);
  printTrace(result);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
