/**
 * x402-seller example: a real, offline session in which an agent operates two
 * paid endpoints and the seller's own constitution — not the operator, not the
 * caller — decides what may change.
 *
 * The scripted operator, in one run:
 *   1. sells five endpoint calls (quote → settle) — each writes revenue to the
 *      ledger;
 *   2. tries to raise a price ABOVE the policy cap  → BLOCKED by governance;
 *   3. raises a price within the cap                → allowed;
 *   4. tries to refund a sale for a reason no policy names → BLOCKED;
 *   5. refunds that same sale for a policy reason   → allowed, writes a refund row.
 *
 * The whole thing is a faithful but network-free simulation of x402: no chain,
 * no USDC, no secrets. It proves the governance and the bookkeeping.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPath, type LedgerRow } from "@mainspring/ledger";
import { Seller, type GovernedResult, type SaleReceipt } from "./seller.js";

/** A deterministic clock so the demo (and its test) reproduce byte-for-byte. */
function fixedClock(): () => string {
  return () => "2026-07-08T00:00:00.000Z";
}

export interface SellerDemoResult {
  workspaceDir: string;
  seller: Seller;
  sales: SaleReceipt[];
  priceBlocked: GovernedResult<number>;
  priceAllowed: GovernedResult<number>;
  refundBlocked: GovernedResult<LedgerRow>;
  refundAllowed: GovernedResult<LedgerRow>;
  ledgerCsv: string;
}

/** One buyer round-trip against a paid route: get the 402 quote, "pay" it, settle. */
function buyOnce(seller: Seller, route: string, txRef: string): SaleReceipt {
  const quote = seller.quote(route);
  // Simulated payment: the buyer pays exactly what was quoted. NO network.
  return seller.settle({ quoteId: quote.quoteId, amountUsd: quote.amountUsd, txRef });
}

/** Runs the scripted governed-seller session against a workspace, persisting LEDGER.csv. */
export async function runSellerDemo(workspaceDir: string): Promise<SellerDemoResult> {
  const seller = new Seller({
    endpoints: [
      { route: "/summarize", priceUsd: 0.02, description: "Summarize a document" },
      { route: "/classify", priceUsd: 0.01, description: "Classify a snippet" },
    ],
    policy: {
      maxPriceUsd: 0.1,
      refundReasons: ["duplicate-charge", "service-unavailable"],
    },
    now: fixedClock(),
  });

  // 1. Five ordinary sales — every one lands in the ledger as revenue.
  const sales = [
    buyOnce(seller, "/summarize", "0xtx01"),
    buyOnce(seller, "/summarize", "0xtx02"),
    buyOnce(seller, "/summarize", "0xtx03"),
    buyOnce(seller, "/classify", "0xtx04"),
    buyOnce(seller, "/classify", "0xtx05"),
  ];

  // 2. An over-cap price change — governance BLOCKS it; the price is untouched.
  const priceBlocked = seller.setPrice("/summarize", 0.5);
  // 3. A within-cap price change — allowed.
  const priceAllowed = seller.setPrice("/summarize", 0.05);

  // 4. A refund with a reason no policy names — BLOCKED, nothing hits the ledger.
  const refundBlocked = seller.refund(sales[0].saleId, "changed-my-mind");
  // 5. The same sale, refunded for a policy reason — allowed, writes a refund row.
  const refundAllowed = seller.refund(sales[0].saleId, "service-unavailable");

  const ledgerCsv = seller.ledgerCsv();
  await writeFile(ledgerPath(workspaceDir), ledgerCsv, "utf8");

  return { workspaceDir, seller, sales, priceBlocked, priceAllowed, refundBlocked, refundAllowed, ledgerCsv };
}

function printResult(result: SellerDemoResult): void {
  console.log(`Mainspring x402-seller — workspace: ${result.workspaceDir}\n`);

  console.log("Audit trail (settle / price change / refund):");
  for (const e of result.seller.audit) {
    const mark = e.allowed ? "✓ ALLOWED" : "✗ BLOCKED";
    const amt = Number.isFinite(e.amountUsd) ? `$${e.amountUsd.toFixed(2)}` : "$   n/a";
    console.log(`  ${mark}  ${e.op.padEnd(9)} ${amt.padStart(8)}  ${e.target}`);
    console.log(`             ${e.reason}`);
  }

  console.log(`\nNet revenue (after refunds): $${result.seller.netRevenueUsd().toFixed(2)}`);
  console.log(`\nLEDGER.csv:\n${result.ledgerCsv.trimEnd()}`);
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-x402-seller-"));
  const result = await runSellerDemo(workspaceDir);
  printResult(result);

  // Fail loudly if governance did not do its job — this example doubles as a smoke test.
  const problems: string[] = [];
  if (result.priceBlocked.allowed) problems.push("over-cap price change was NOT blocked");
  if (!result.priceAllowed.allowed) problems.push("within-cap price change was wrongly blocked");
  if (result.refundBlocked.allowed) problems.push("off-policy refund was NOT blocked");
  if (!result.refundAllowed.allowed) problems.push("policy refund was wrongly blocked");
  // 5 sales @ (0.02×3 + 0.01×2) = 0.08, minus one 0.02 refund = 0.06 net.
  if (result.seller.netRevenueUsd() !== 0.06) problems.push(`net revenue is $${result.seller.netRevenueUsd()}, expected $0.06`);
  if (problems.length > 0) {
    throw new Error(`x402-seller example did not enforce policy: ${problems.join("; ")}`);
  }

  // Prove persistence round-trips: the file on disk matches what we reported.
  const onDisk = await readFile(ledgerPath(workspaceDir), "utf8");
  if (onDisk !== result.ledgerCsv) throw new Error("persisted LEDGER.csv does not match the reported ledger");
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
