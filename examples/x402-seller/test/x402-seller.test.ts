import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "@mainspring/ledger";
import { runSellerDemo } from "../src/main.js";
import { Seller, SellerError } from "../src/seller.js";

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "x402-seller-example-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Build a fresh seller with a fixed clock for reproducible ledger dates. */
function newSeller(): Seller {
  return new Seller({
    endpoints: [
      { route: "/summarize", priceUsd: 0.02 },
      { route: "/classify", priceUsd: 0.01 },
    ],
    policy: { maxPriceUsd: 0.1, refundReasons: ["duplicate-charge", "service-unavailable"] },
    now: () => "2026-07-08T00:00:00.000Z",
  });
}

function sell(seller: Seller, route: string, txRef = "0xabc") {
  const quote = seller.quote(route);
  return seller.settle({ quoteId: quote.quoteId, amountUsd: quote.amountUsd, txRef });
}

test("the runnable demo settles sales, blocks the over-cap price + off-policy refund, and ledgers correctly", async () => {
  await withWorkspace(async (dir) => {
    const r = await runSellerDemo(dir);

    // Five sales all settled with 200 receipts.
    assert.equal(r.sales.length, 5);
    assert.ok(r.sales.every((s) => s.status === 200));

    // Governance verdicts.
    assert.equal(r.priceBlocked.allowed, false);
    assert.ok(r.priceBlocked.firedRules.includes("price-cap"));
    assert.equal(r.priceAllowed.allowed, true);
    assert.equal(r.refundBlocked.allowed, false);
    assert.ok(r.refundBlocked.firedRules.includes("refund-policy"));
    assert.equal(r.refundAllowed.allowed, true);

    // The blocked price change left the price untouched; the allowed one applied.
    assert.equal(r.seller.priceOf("/summarize"), 0.05);

    // Net revenue: 0.02×3 + 0.01×2 = 0.08, minus one 0.02 refund = 0.06.
    assert.equal(r.seller.netRevenueUsd(), 0.06);

    // The persisted LEDGER.csv is valid per the ledger's own invariant, and
    // matches what the demo reported.
    const onDisk = await readFile(join(dir, "LEDGER.csv"), "utf8");
    assert.equal(onDisk, r.ledgerCsv);
    const parsed = Ledger.fromCsv(onDisk); // throws if the balance invariant is violated
    assert.equal(parsed.balance(), 0.06);

    // Five revenue rows + one refund row.
    const rows = parsed.entries;
    assert.equal(rows.filter((x) => x.type === "revenue").length, 5);
    assert.equal(rows.filter((x) => x.type === "refund").length, 1);
  });
});

test("a price above the cap is blocked and does not change the price", () => {
  const seller = newSeller();
  const res = seller.setPrice("/summarize", 0.5);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /cap/);
  assert.equal(seller.priceOf("/summarize"), 0.02);
});

test("a price at exactly the cap is allowed; a malformed price is blocked (fail-closed)", () => {
  const seller = newSeller();
  assert.equal(seller.setPrice("/summarize", 0.1).allowed, true);
  assert.equal(seller.priceOf("/summarize"), 0.1);

  // Non-finite and negative prices are denied, never waved through.
  assert.equal(seller.setPrice("/classify", Number.NaN).allowed, false);
  assert.equal(seller.setPrice("/classify", Number.POSITIVE_INFINITY).allowed, false);
  assert.equal(seller.setPrice("/classify", -1).allowed, false);
  assert.equal(seller.priceOf("/classify"), 0.01);
});

test("a refund with no policy reason is blocked; a policy reason is allowed and ledgered once", () => {
  const seller = newSeller();
  const sale = sell(seller, "/summarize");

  const bad = seller.refund(sale.saleId, "changed-my-mind");
  assert.equal(bad.allowed, false);
  assert.ok(bad.firedRules.includes("refund-policy"));
  // Nothing hit the ledger: still just the one revenue row.
  assert.equal(seller.netRevenueUsd(), 0.02);

  const good = seller.refund(sale.saleId, "duplicate-charge");
  assert.equal(good.allowed, true);
  assert.equal(seller.netRevenueUsd(), 0);

  // A second refund of the same sale is refused (no double refunds).
  const again = seller.refund(sale.saleId, "duplicate-charge");
  assert.equal(again.allowed, false);
  assert.match(again.reason, /already refunded/);
  assert.equal(seller.netRevenueUsd(), 0);
});

test("settle verifies the payment against the quote and enforces single use", () => {
  const seller = newSeller();
  const quote = seller.quote("/summarize");

  // Underpayment is refused.
  assert.throws(() => seller.settle({ quoteId: quote.quoteId, amountUsd: 0.01, txRef: "0x1" }), SellerError);

  // A correct payment settles.
  const receipt = seller.settle({ quoteId: quote.quoteId, amountUsd: 0.02, txRef: "0x2" });
  assert.equal(receipt.amountUsd, 0.02);

  // Replaying the same (now consumed) quote is refused.
  assert.throws(() => seller.settle({ quoteId: quote.quoteId, amountUsd: 0.02, txRef: "0x3" }), SellerError);
});

test("unknown routes and over-cap endpoint config are rejected", () => {
  const seller = newSeller();
  assert.throws(() => seller.quote("/nope"), SellerError);
  assert.throws(() => seller.setPrice("/nope", 0.03), SellerError);

  assert.throws(
    () =>
      new Seller({
        endpoints: [{ route: "/pricey", priceUsd: 5 }],
        policy: { maxPriceUsd: 0.1, refundReasons: [] },
      }),
    SellerError,
  );
});
