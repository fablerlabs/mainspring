// Step (c): a spend-capped ledger. Every cent is recorded; the cap is a
// structural refusal, not a polite request in a prompt.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appendLedger, readLedger } from "@mainspring/ledger";
import { checkSpend, DEFAULT_SPEND_POLICY } from "@mainspring/ledger";

const ws = join(process.cwd(), "_ledger-demo");
await rm(ws, { recursive: true, force: true });
await mkdir(ws, { recursive: true });

// A little revenue first, so the balance is real.
await appendLedger(ws, { date: "2026-07-07", type: "revenue", description: "first sale of the pack", amountUsd: 24 });

// The policy mirrors the constitution: under $25 proceeds, $25–75 notifies the
// owner, $75+ needs the owner's approval code before any money moves.
console.log("policy:", JSON.stringify(DEFAULT_SPEND_POLICY), "\n");

const spends = [
  { desc: "domain for a year", amountUsd: 12 },
  { desc: "a month of email sending", amountUsd: 40 },
  { desc: "a paid ad burst", amountUsd: 120 },
];

for (const s of spends) {
  const decision = checkSpend(s.amountUsd, DEFAULT_SPEND_POLICY);
  if (decision === "proceed") {
    const row = await appendLedger(ws, { date: "2026-07-07", type: "expense", description: s.desc, amountUsd: s.amountUsd });
    console.log(`$${s.amountUsd} ${s.desc.padEnd(28)} → PROCEED, spent. balance now $${row.balanceUsd.toFixed(2)}`);
  } else {
    console.log(`$${s.amountUsd} ${s.desc.padEnd(28)} → ${decision.toUpperCase()} — held, no money moved`);
  }
}

const ledger = await readLedger(ws);
console.log(`\nLedger has ${ledger.entries.length} rows; final balance $${ledger.balance().toFixed(2)}.`);
