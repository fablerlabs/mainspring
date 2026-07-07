/**
 * Spend-guard example: a real Mainspring session in which the runtime — not
 * the brain, not the caller — enforces the constitution's spend tiers.
 *
 *   @mainspring/core    — runSession(), the constitution-enforcing loop, now
 *                         carrying the policy-tier spend gate (spendGate.ts)
 *   @mainspring/brains  — MockBrain, a deterministic scripted Brain
 *   @mainspring/ledger  — the spend-cap thresholds (DEFAULT_SPEND_POLICY)
 *
 * The scripted agent proposes two spends in one session:
 *   1. a $5 tool subscription  — under the auto-approve threshold → PROCEEDS,
 *      and lands in LEDGER.csv;
 *   2. a $500 ad buy           — at/above the approval-code threshold →
 *      BLOCKED by the runtime before it can touch the ledger, with the
 *      spend gate's own reason cited.
 *
 * The hard per-session cap (moneyCaps.perSessionUsd) is set high on purpose so
 * that it is the *policy-tier spend gate*, not the hard ceiling, that blocks
 * the $500 — that finer layer is what this example demonstrates. No network,
 * no secrets, no real money: this proves the guard, not a business.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession, type Constitution, type StepResult, type SessionSummary } from "@mainspring/core";
import { MockBrain } from "@mainspring/brains";
import { DEFAULT_SPEND_POLICY } from "@mainspring/ledger";

export const constitution: Constitution = {
  name: "Spend-Guard Example Business",
  mission: "Show the runtime blocking an over-cap spend and allowing an under-cap one.",
  hardRules: [
    "Legal and honest only.",
    "Every dollar of spend respects the session's caps; over-cap spend needs the owner.",
  ],
  // The hard ceiling is high so the *policy-tier* spend gate does the blocking below.
  moneyCaps: { perSessionUsd: 10_000, notifyAboveUsd: 25, approvalAboveUsd: 75 },
  maxSessionMs: 40 * 60 * 1000,
};

/** A two-step business day: a small allowed spend, then a large one the runtime must block. */
export function buildScript(): StepResult[] {
  const usage = { inputTokens: 0, outputTokens: 0, wallMs: 0 };
  const today = new Date().toISOString();

  return [
    {
      done: false,
      usage,
      actions: [
        {
          kind: "ledger",
          entry: { date: today, type: "expense", description: "analytics-tool-subscription", amountUsd: 5 },
        },
      ],
    },
    {
      done: true,
      usage,
      actions: [
        {
          kind: "ledger",
          entry: { date: today, type: "expense", description: "reddit-ad-buy", amountUsd: 500 },
        },
        { kind: "done" },
      ],
    },
  ];
}

export interface SpendGuardResult {
  workspaceDir: string;
  summary: SessionSummary;
  ledgerCsv: string;
  /** The parsed .mainspring/last-session.json, including the spend audit trail. */
  lastSession: {
    spendAudit: Array<{ op: string; amountUsd?: number; allowed: boolean; reason: string; decision: string }>;
    spendNotices: string[];
  };
}

/** Runs the scripted session with the spend gate wired on (via `spendPolicy`). */
export async function runSpendGuard(workspaceDir: string): Promise<SpendGuardResult> {
  const summary = await runSession({
    workspaceDir,
    constitution,
    brain: new MockBrain(buildScript()),
    // Wire the policy-tier spend gate on with the constitution's default bands.
    spendPolicy: DEFAULT_SPEND_POLICY,
    commit: false,
  });

  const ledgerCsv = await readFile(join(workspaceDir, "LEDGER.csv"), "utf8").catch(() => "");
  const lastSession = JSON.parse(await readFile(join(workspaceDir, ".mainspring", "last-session.json"), "utf8"));

  return { workspaceDir, summary, ledgerCsv, lastSession };
}

function printResult(result: SpendGuardResult): void {
  console.log(`Mainspring spend-guard — workspace: ${result.workspaceDir}\n`);
  for (const entry of result.lastSession.spendAudit) {
    const mark = entry.allowed ? "✓ ALLOWED" : "✗ BLOCKED";
    console.log(`  ${mark}  $${entry.amountUsd?.toFixed(2)}  ${entry.op}`);
    console.log(`             ${entry.reason}`);
  }
  console.log(`\nSpent this session: $${result.summary.spentUsd.toFixed(2)} (only the allowed spend)`);
  console.log(`Actions blocked:    ${result.summary.actionsBlocked}`);
  console.log(`\nLEDGER.csv:\n${result.ledgerCsv.trimEnd()}`);
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-spend-guard-"));
  const result = await runSpendGuard(workspaceDir);
  printResult(result);

  // Fail loudly if the guard did not do its job — this example doubles as a smoke test.
  if (result.summary.actionsBlocked !== 1 || result.summary.spentUsd !== 5) {
    throw new Error("spend-guard example did not enforce the expected block; the wiring is broken");
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
