import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedger } from "@mainspring/ledger";
import { runX402Buyer, X402_SPEND_CAPS } from "../src/main.js";
import { MockX402Transport } from "../src/x402.js";

const CATALOG = {
  "https://data.example/eod-report": { priceUsd: 0.4, payTo: "0xMerchant.eod", body: "EOD market report CSV\n" },
  "https://data.example/sentiment-snippet": { priceUsd: 0.35, payTo: "0xMerchant.sentiment", body: "Sentiment snippet JSON\n" },
  "https://data.example/full-history-dump": { priceUsd: 3.5, payTo: "0xMerchant.history", body: "Full history dump\n" },
  "https://data.example/weekly-digest": { priceUsd: 1.8, payTo: "0xMerchant.digest", body: "Weekly digest PDF\n" },
  "https://data.example/macro-outlook": { priceUsd: 1.9, payTo: "0xMerchant.macro", body: "Macro outlook PDF\n" },
  "https://data.example/another-report": { priceUsd: 0.8, payTo: "0xMerchant.another", body: "Another report\n" },
};

const PLAN = [
  "https://data.example/eod-report",
  "https://data.example/sentiment-snippet",
  "https://data.example/full-history-dump",
  "https://data.example/weekly-digest",
  "https://data.example/macro-outlook",
  "https://data.example/another-report",
];

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mainspring-x402-buyer-test-"));
}

test("purchases within both caps are allowed, paid, and recorded on the ledger in order", async () => {
  const workspaceDir = await tempWorkspace();
  const transport = new MockX402Transport(CATALOG);
  const result = await runX402Buyer(workspaceDir, transport, PLAN);

  const allowed = [result.purchases[0], result.purchases[1], result.purchases[3], result.purchases[4]];
  for (const p of allowed) {
    assert.equal(p.verdict, "allow");
    assert.equal(p.applied, true);
  }

  assert.deepEqual(transport.paidUrls, [
    "https://data.example/eod-report",
    "https://data.example/sentiment-snippet",
    "https://data.example/weekly-digest",
    "https://data.example/macro-outlook",
  ]);

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 4, "only the four allowed purchases reach the ledger");
  assert.deepEqual(
    ledger.entries.map((e) => e.amountUsd),
    [0.4, 0.35, 1.8, 1.9],
  );
  assert.equal(ledger.balance(), -4.45);
  assert.equal(result.spentTodayUsd, 4.45);
});

test("a purchase over the per-action cap is blocked before payment, cited by rule id, even with daily budget to spare", async () => {
  const workspaceDir = await tempWorkspace();
  const transport = new MockX402Transport(CATALOG);
  const result = await runX402Buyer(workspaceDir, transport, PLAN);

  const blocked = result.purchases[2];
  assert.equal(blocked.url, "https://data.example/full-history-dump");
  assert.equal(blocked.priceUsd, 3.5);
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.applied, false);
  assert.ok(
    blocked.firedRules.some((r) => r.id === "x402-per-action-cap"),
    "governance must name the specific rule that fired, not just refuse silently",
  );
  assert.ok(
    !blocked.firedRules.some((r) => r.id === "x402-daily-cap"),
    "the day still had $4.25 of headroom left ($0.75 spent + $3.50 = $4.25 <= $5.00) — only the per-action cap accounts for this block",
  );

  assert.ok(
    !transport.paidUrls.includes("https://data.example/full-history-dump"),
    "a blocked purchase must never reach transport.pay()",
  );
});

test("a purchase under the per-action cap but over the day's remaining budget is blocked by the daily cap alone", async () => {
  const workspaceDir = await tempWorkspace();
  const transport = new MockX402Transport(CATALOG);
  const result = await runX402Buyer(workspaceDir, transport, PLAN);

  const blocked = result.purchases[5];
  assert.equal(blocked.url, "https://data.example/another-report");
  assert.ok(blocked.priceUsd <= X402_SPEND_CAPS.perActionUsd, "this purchase is individually within the per-action cap");
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.applied, false);
  assert.ok(
    blocked.firedRules.some((r) => r.id === "x402-daily-cap"),
    "the daily cap, not the per-action cap, must be the one that fires here",
  );
  assert.ok(!blocked.firedRules.some((r) => r.id === "x402-per-action-cap"));

  assert.ok(!transport.paidUrls.includes("https://data.example/another-report"));
});

test("blocked purchases never reach the ledger; only the four allowed purchases do", async () => {
  const workspaceDir = await tempWorkspace();
  const transport = new MockX402Transport(CATALOG);
  await runX402Buyer(workspaceDir, transport, PLAN);

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 4);
  for (const entry of ledger.entries) {
    assert.equal(entry.type, "expense");
  }
});

test("the daily cap is stateful across the loop: it only fires once the running total actually crosses it", async () => {
  const workspaceDir = await tempWorkspace();
  const transport = new MockX402Transport(CATALOG);
  // Same $1.90 price requested three times against the default $5.00 daily
  // cap: the first two ($1.90, $3.80 running) are allowed and the third
  // ($5.70 running) is the first to cross it.
  const result = await runX402Buyer(workspaceDir, transport, [
    "https://data.example/macro-outlook",
    "https://data.example/macro-outlook",
    "https://data.example/macro-outlook",
  ]);

  assert.deepEqual(
    result.purchases.map((p) => p.verdict),
    ["allow", "allow", "block"],
  );
  assert.equal(result.spentTodayUsd, 3.8);

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 2);
});
