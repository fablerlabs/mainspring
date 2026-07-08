/**
 * Quickstart: a real Mainspring session loop, assembled by hand from five
 * packages, run entirely offline with a scripted brain.
 *
 *   @mainspring/core       — Constitution/Action/SessionInput types, assemble()
 *   @mainspring/brains     — MockBrain, a deterministic, scripted Brain
 *   @mainspring/governance — CONSTITUTION.md -> Rule[], evaluate() gates every Action
 *   @mainspring/ledger     — appendLedger()/readLedger(), the invariant-checked LEDGER.csv
 *   @mainspring/memory     — appendJournal()/appendSession(), the durable session memory
 *
 * No network, no secrets, no real spend: this proves the wiring, not a business.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemble,
  applyAction,
  type Action,
  type Constitution,
  type StepResult,
  type ToolSpec,
  type Turn,
} from "@mainspring/core";
import { MockBrain } from "@mainspring/brains";
import { loadConstitutionRules, evaluate, type FiredRule } from "@mainspring/governance";
import { appendLedger, readLedger } from "@mainspring/ledger";
import { appendJournal, appendSession, journalPath, sessionLogPath } from "@mainspring/memory";

export const CONSTITUTION_MD = `# CONSTITUTION — Quickstart Example Business

## Mission
Prove the Mainspring loop end to end, offline, with zero credentials.

## Hard rules
1. Legal and honest only.
2. You are an AI and never claim otherwise when posting or publishing. <!-- rule:honesty-disclosure -->
3. Secrets never appear in a write, notification, or tool call. <!-- rule:no-secrets -->
4. Every dollar of spend respects the session's caps; over-cap spend needs the owner. <!-- rule:spend-caps -->
5. Only pre-approved tools may be called from a session. <!-- rule:external-allowlist -->
`;

export const constitution: Constitution = {
  name: "Quickstart Example Business",
  mission: "Prove the Mainspring loop end to end, offline, with zero credentials.",
  hardRules: [
    "Legal and honest only.",
    "You are an AI and never claim otherwise when posting or publishing.",
    "Secrets never appear in a write, notification, or tool call.",
    "Every dollar of spend respects the session's caps; over-cap spend needs the owner.",
    "Only pre-approved tools may be called from a session.",
  ],
  moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 10, approvalAboveUsd: 75 },
  maxSessionMs: 40 * 60 * 1000,
};

/** The one external tool this workspace knows about — declared, but never actually called. */
const ALLOWED_TOOLS = ["post-to-reddit"];
const tools: ToolSpec[] = [
  { name: "post-to-reddit", description: "Draft a Reddit post for the owner to review and post themselves." },
];

/**
 * A scripted 3-step business day: (1) an allowed write + notify, (2) a
 * publish attempt that omits the required AI-disclosure flag — governance
 * must block it — and (3) a $0 ledger adjustment plus `done`.
 */
function buildScript(): StepResult[] {
  const usage = { inputTokens: 0, outputTokens: 0, wallMs: 0 };
  const now = () => new Date().toISOString();

  return [
    {
      done: false,
      usage,
      actions: [
        { kind: "notify", to: "owner", text: "Quickstart session started: drafting landing-page copy, no spend yet." },
        {
          kind: "write",
          path: "notes/landing-copy.md",
          content: "# Landing copy draft\n\nHonest, AI-authored product copy. No fake reviews, no impersonation.\n",
        },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        { kind: "run", tool: "post-to-reddit", args: { text: "Check out our new tool, it's amazing!" } },
      ],
    },
    {
      done: true,
      usage,
      actions: [
        {
          kind: "ledger",
          entry: { date: now(), type: "adjustment", description: "Quickstart proof-of-life entry — no real money moved.", amountUsd: 0 },
        },
        { kind: "done" },
      ],
    },
  ];
}

export interface ActionTrace {
  action: Action;
  verdict: "allow" | "block" | "escalate";
  firedRules: FiredRule[];
  applied: boolean;
  detail: string;
}

export interface StepTrace {
  step: number;
  actions: ActionTrace[];
}

export interface QuickstartResult {
  workspaceDir: string;
  steps: StepTrace[];
  ledgerBalanceUsd: number;
  journalFile: string;
  sessionLogFile: string;
}

/**
 * Runs the scripted session against `workspaceDir`: assemble -> brain.step ->
 * governance.evaluate -> dispatch (ledger package for money, core's dispatch
 * for everything else) -> memory (journal + session log). Mirrors the shape
 * of `@mainspring/core`'s `runSession`, but swaps in the governance and
 * ledger packages instead of core's own built-in gate/ledger-write so all
 * five packages are exercised together.
 */
export async function runQuickstart(workspaceDir: string): Promise<QuickstartResult> {
  const brain = new MockBrain(buildScript());
  const history: Turn[] = [];
  const steps: StepTrace[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // Mark the generated journal with a one-line, honest, removable attribution
  // header before any session content lands — the same "generated by <tool>"
  // convention scaffolders use, written through the public journal API so the
  // on-disk format stays valid (an HTML comment, so it renders as nothing).
  await appendJournal(workspaceDir, today, "<!-- generated by mainspring -->");

  let spentSoFarUsd = 0;
  let stepNumber = 0;
  let done = false;

  while (!done) {
    stepNumber += 1;
    const input = await assemble(workspaceDir, constitution, tools);
    const stepResult = await brain.step(input, history);

    const { rules } = loadConstitutionRules(CONSTITUTION_MD, {
      moneyCaps: constitution.moneyCaps,
      spentSoFarUsd,
      approvalCodePresent: false,
      allowedTools: ALLOWED_TOOLS,
    });

    const stepTrace: StepTrace = { step: stepNumber, actions: [] };

    for (const action of stepResult.actions) {
      const { verdict, firedRules } = evaluate(action, rules);
      let applied = false;
      let detail = "";

      if (verdict === "allow") {
        if (action.kind === "ledger") {
          const row = await appendLedger(workspaceDir, action.entry);
          applied = true;
          detail = `ledger balance now $${row.balanceUsd.toFixed(2)}`;
          if (action.entry.type === "expense") spentSoFarUsd += action.entry.amountUsd;
        } else if (action.kind === "run") {
          // Declared allowed, but this example registers no tool handlers:
          // MockBrain never needs a real external call to prove the wiring.
          detail = "allowed by governance, but no tool handler is registered in this example";
        } else {
          const dispatchResult = await applyAction(action, { workspaceDir });
          applied = dispatchResult.applied;
          detail = dispatchResult.detail ?? "";
        }
      } else {
        detail = firedRules.map((r) => `${r.id} (${r.verdict}): ${r.description}`).join(" | ");
      }

      stepTrace.actions.push({ action, verdict, firedRules, applied, detail });
    }

    await appendJournal(
      workspaceDir,
      today,
      [
        `### step ${stepNumber}`,
        ...stepTrace.actions.map((a) => `- [${a.verdict}] ${a.action.kind}: ${a.detail}`),
      ].join("\n"),
    );

    history.push({ role: "brain", content: JSON.stringify(stepResult.actions), at: new Date().toISOString() });
    steps.push(stepTrace);
    done = stepResult.done;
  }

  await appendSession(workspaceDir, {
    ts: new Date().toISOString(),
    steps: steps.length,
    actions: steps.reduce((sum, s) => sum + s.actions.length, 0),
    outcome: "done",
  });

  const ledger = await readLedger(workspaceDir);

  return {
    workspaceDir,
    steps,
    ledgerBalanceUsd: ledger.balance(),
    journalFile: journalPath(workspaceDir, today),
    sessionLogFile: sessionLogPath(workspaceDir),
  };
}

function printTrace(result: QuickstartResult): void {
  console.log(`Mainspring quickstart — workspace: ${result.workspaceDir}\n`);
  for (const step of result.steps) {
    console.log(`Step ${step.step}:`);
    for (const a of step.actions) {
      const mark = a.verdict === "allow" ? "✓ ALLOWED" : `✗ ${a.verdict.toUpperCase()}`;
      console.log(`  ${mark}  ${a.action.kind}  ${a.detail}`);
    }
  }
  console.log(`\nLedger balance: $${result.ledgerBalanceUsd.toFixed(2)}`);
  console.log(`Journal:     ${result.journalFile}`);
  console.log(`Session log: ${result.sessionLogFile}`);
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-quickstart-"));
  const result = await runQuickstart(workspaceDir);
  printTrace(result);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
