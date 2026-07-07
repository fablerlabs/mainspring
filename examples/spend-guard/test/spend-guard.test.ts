import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSpendGuard } from "../src/main.js";

/**
 * Verifies the runnable example actually enforces the spend guard end to end:
 * the $5 spend lands in the ledger, the $500 spend is blocked by the runtime
 * with a cited reason, and both are audited.
 */

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spend-guard-example-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the $5 spend is allowed and ledgered; the $500 spend is blocked with a citation", async () => {
  await withWorkspace(async (dir) => {
    const { summary, ledgerCsv, lastSession } = await runSpendGuard(dir);

    assert.equal(summary.actionsBlocked, 1);
    assert.equal(summary.spentUsd, 5);
    assert.ok(summary.blockedReasons.some((r) => /needs the owner's approval code/.test(r)));

    assert.match(ledgerCsv, /expense,analytics-tool-subscription,5\.00/);
    assert.doesNotMatch(ledgerCsv, /reddit-ad-buy/);

    assert.deepEqual(
      lastSession.spendAudit.map((e) => ({ op: e.op, allowed: e.allowed })),
      [
        { op: "analytics-tool-subscription", allowed: true },
        { op: "reddit-ad-buy", allowed: false },
      ],
    );
    assert.equal(lastSession.spendAudit[1].decision, "needs-approval");
  });
});
