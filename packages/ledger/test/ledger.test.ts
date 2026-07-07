import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Ledger,
  LedgerInvariantError,
  LEDGER_CSV_HEADER,
  ledgerPath,
  readLedger,
  appendLedger,
  type LedgerEntry,
} from "../src/ledger.js";
import { checkSpend, DEFAULT_SPEND_POLICY, type SpendPolicy } from "../src/caps.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mainspring-ledger-"));
}

const SALE: LedgerEntry = { date: "2026-07-01T00:00:00.000Z", type: "revenue", description: "pack sale", amountUsd: 24 };
const HOSTING: LedgerEntry = { date: "2026-07-02T00:00:00.000Z", type: "expense", description: "VPS", amountUsd: 20 };
const REFUND: LedgerEntry = { date: "2026-07-03T00:00:00.000Z", type: "refund", description: "chargeback", amountUsd: 4 };
const NOTE: LedgerEntry = { date: "2026-07-04T00:00:00.000Z", type: "adjustment", description: "reconciled", amountUsd: 0 };

// --- Ledger: balance + round-trip -------------------------------------------

test("append computes the running balance per entry type", () => {
  const ledger = new Ledger();
  assert.equal(ledger.balance(), 0);

  assert.equal(ledger.append(SALE).balanceUsd, 24);
  assert.equal(ledger.append(HOSTING).balanceUsd, 4);
  assert.equal(ledger.append(REFUND).balanceUsd, 0);
  assert.equal(ledger.append(NOTE).balanceUsd, 0);

  assert.equal(ledger.balance(), 0);
  assert.equal(ledger.entries.length, 4);
});

test("toCsv / fromCsv round-trips entries and balances exactly", () => {
  const ledger = new Ledger();
  ledger.append(SALE);
  ledger.append(HOSTING);
  ledger.append(REFUND);

  const csv = ledger.toCsv();
  assert.ok(csv.startsWith(`${LEDGER_CSV_HEADER}\n`));

  const reloaded = Ledger.fromCsv(csv);
  assert.deepEqual(reloaded.entries, ledger.entries);
  assert.equal(reloaded.balance(), ledger.balance());
  assert.equal(reloaded.toCsv(), csv);
});

test("fromCsv on an empty or header-only document yields an empty ledger", () => {
  assert.equal(Ledger.fromCsv("").entries.length, 0);
  assert.equal(Ledger.fromCsv(`${LEDGER_CSV_HEADER}\n`).entries.length, 0);
});

test("descriptions containing commas and quotes survive a round trip", () => {
  const ledger = new Ledger();
  ledger.append({ date: "2026-07-01", type: "revenue", description: 'sale, "big" one', amountUsd: 10 });
  const reloaded = Ledger.fromCsv(ledger.toCsv());
  assert.equal(reloaded.entries[0].description, 'sale, "big" one');
});

// --- Ledger: balance invariant rejection ------------------------------------

test("fromCsv rejects a row whose balance_usd breaks the running-balance invariant", () => {
  const bad = [LEDGER_CSV_HEADER, "2026-07-01,revenue,pack sale,24.00,24.00", "2026-07-02,expense,VPS,20.00,10.00"].join(
    "\n",
  );
  assert.throws(() => Ledger.fromCsv(bad), LedgerInvariantError);
});

test("fromCsv rejects a header that doesn't match the expected schema", () => {
  assert.throws(() => Ledger.fromCsv("date,type,description,amount,balance\n"), LedgerInvariantError);
});

test("fromCsv rejects an unknown entry type", () => {
  const bad = [LEDGER_CSV_HEADER, "2026-07-01,bonus,pack sale,24.00,24.00"].join("\n");
  assert.throws(() => Ledger.fromCsv(bad), LedgerInvariantError);
});

test("append rejects a negative amountUsd", () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.append({ date: "2026-07-01", type: "revenue", description: "bad", amountUsd: -1 }),
    LedgerInvariantError,
  );
});

// --- Ledger: append-only enforcement ----------------------------------------

test("entries is a frozen snapshot; mutating it cannot affect the ledger", () => {
  const ledger = new Ledger();
  ledger.append(SALE);
  const snapshot = ledger.entries;

  assert.throws(() => (snapshot as unknown as LedgerEntry[]).push(HOSTING));
  assert.equal(ledger.entries.length, 1);
});

test("appendLedger on disk never rewrites existing bytes (append-only)", async () => {
  const ws = await tempWorkspace();

  await appendLedger(ws, SALE);
  const afterFirst = await readFile(ledgerPath(ws), "utf8");

  await appendLedger(ws, HOSTING);
  const afterSecond = await readFile(ledgerPath(ws), "utf8");

  assert.ok(afterSecond.startsWith(afterFirst), "prior bytes must remain an untouched prefix");
  assert.equal(afterSecond.length > afterFirst.length, true);
});

test("appendLedger creates the file with a header on first write and reports the running balance", async () => {
  const ws = await tempWorkspace();
  const row = await appendLedger(ws, SALE);
  assert.equal(row.balanceUsd, 24);

  const text = await readFile(ledgerPath(ws), "utf8");
  assert.match(text, new RegExp(`^${LEDGER_CSV_HEADER}\n`));
});

test("readLedger returns an empty ledger when LEDGER.csv does not exist", async () => {
  const ws = await tempWorkspace();
  const ledger = await readLedger(ws);
  assert.equal(ledger.entries.length, 0);
  assert.equal(ledger.balance(), 0);
});

test("readLedger surfaces a tampered on-disk ledger via LedgerInvariantError", async () => {
  const ws = await tempWorkspace();
  await appendLedger(ws, SALE);
  await writeFile(ledgerPath(ws), `${LEDGER_CSV_HEADER}\n2026-07-01,revenue,pack sale,24.00,999.00\n`, "utf8");

  await assert.rejects(() => readLedger(ws), LedgerInvariantError);
});

// --- caps: checkSpend --------------------------------------------------------

test("checkSpend: proceed below autoApproveUnder", () => {
  assert.equal(checkSpend(0), "proceed");
  assert.equal(checkSpend(24.99), "proceed");
});

test("checkSpend: notify between autoApproveUnder and approvalCodeOver", () => {
  assert.equal(checkSpend(25), "notify");
  assert.equal(checkSpend(50), "notify");
  assert.equal(checkSpend(74.99), "notify");
});

test("checkSpend: needs-approval at/above approvalCodeOver", () => {
  assert.equal(checkSpend(75), "needs-approval");
  assert.equal(checkSpend(1000), "needs-approval");
});

test("checkSpend honors a custom policy", () => {
  const policy: SpendPolicy = { autoApproveUnder: 10, notifyUnder: 50, approvalCodeOver: 50 };
  assert.equal(checkSpend(5, policy), "proceed");
  assert.equal(checkSpend(10, policy), "notify");
  assert.equal(checkSpend(49, policy), "notify");
  assert.equal(checkSpend(50, policy), "needs-approval");
});

test("DEFAULT_SPEND_POLICY matches the constitution's 25/75/75 thresholds", () => {
  assert.deepEqual(DEFAULT_SPEND_POLICY, { autoApproveUnder: 25, notifyUnder: 75, approvalCodeOver: 75 });
});
