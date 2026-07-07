import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "../src/index.js";
import type { Action, Brain, Constitution, StepResult, Usage } from "../src/index.js";

/**
 * Integration tests for the spend gate wired into runSession. They prove the
 * *runtime* — not the caller — blocks a needs-approval spend before it reaches
 * disk, while letting an under-threshold spend through and ledgering it. The
 * Constitution's hard per-session cap is set high so the finer spend gate, not
 * the hard cap in gate.ts, is what does the blocking here.
 */

const constitution: Constitution = {
  name: "Test Business",
  mission: "test",
  hardRules: ["Legal and honest only."],
  // perSessionUsd deliberately high so a $500 expense clears the hard gate and
  // reaches the policy-tier spend gate — that layer is what we're testing.
  moneyCaps: { perSessionUsd: 10_000, notifyAboveUsd: 25, approvalAboveUsd: 75 },
  maxSessionMs: 40 * 60 * 1000,
};

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, wallMs: 0 };
}

/** Emits one scripted batch, then reports done — an untrusted model stand-in. */
class OnceBrain implements Brain {
  readonly id = "once";
  readonly model = "test-once";
  private used = false;
  constructor(private readonly batch: Action[]) {}
  async step(): Promise<StepResult> {
    if (this.used) return { actions: [{ kind: "done" }], usage: zeroUsage(), done: true };
    this.used = true;
    return { actions: this.batch, usage: zeroUsage(), done: false };
  }
}

const FIXED = "2026-07-07T00:00:00.000Z";
const expense = (amountUsd: number, description: string): Action => ({
  kind: "ledger",
  entry: { date: FIXED, type: "expense", description, amountUsd },
});

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ms-spend-loop-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runtime blocks the over-cap spend and ledgers the under-cap one, in one session", async () => {
  await withWorkspace(async (ws) => {
    const brain = new OnceBrain([
      expense(5, "small-tool"), // under $25 → proceeds, hits the ledger
      expense(500, "big-thing"), // >= $75 → needs approval → BLOCKED by the runtime
    ]);

    const summary = await runSession({
      workspaceDir: ws,
      constitution,
      brain,
      spendPolicy: { autoApproveUnder: 25, notifyUnder: 75, approvalCodeOver: 75 },
      commit: false,
    });

    // One allowed ($5), one blocked ($500) — the spend gate did the blocking.
    assert.equal(summary.actionsAllowed, 2); // the $5 expense + the final `done`
    assert.equal(summary.actionsBlocked, 1);
    assert.ok(summary.blockedReasons.some((r) => /needs the owner's approval code/.test(r)));

    // Only the $5 expense reached the ledger; the $500 never did.
    const ledger = await readFile(join(ws, "LEDGER.csv"), "utf8");
    assert.match(ledger, /expense,small-tool,5\.00/);
    assert.doesNotMatch(ledger, /big-thing/);
    assert.equal(summary.spentUsd, 5);

    // Both spend attempts were audited (allow + deny) in last-session.json.
    const lastSession = JSON.parse(await readFile(join(ws, ".mainspring", "last-session.json"), "utf8"));
    assert.equal(lastSession.spendAudit.length, 2);
    assert.deepEqual(
      lastSession.spendAudit.map((e: { op: string; allowed: boolean }) => ({ op: e.op, allowed: e.allowed })),
      [
        { op: "small-tool", allowed: true },
        { op: "big-thing", allowed: false },
      ],
    );
  });
});

test("without spendPolicy the loop is unchanged: a $500 expense under a high hard cap is dispatched", async () => {
  await withWorkspace(async (ws) => {
    const brain = new OnceBrain([expense(500, "big-thing")]);
    const summary = await runSession({ workspaceDir: ws, constitution, brain, commit: false });

    assert.equal(summary.actionsBlocked, 0);
    assert.equal(summary.spentUsd, 500);
    assert.match(await readFile(join(ws, "LEDGER.csv"), "utf8"), /expense,big-thing,500\.00/);

    // No spend gate → no spend audit recorded.
    const lastSession = JSON.parse(await readFile(join(ws, ".mainspring", "last-session.json"), "utf8"));
    assert.deepEqual(lastSession.spendAudit, []);
  });
});
