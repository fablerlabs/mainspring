/**
 * Full-stack integration proof: a single realistic multi-step session that
 * wires SEVEN packages together end to end, offline, with zero credentials.
 *
 *   @mainspring/core       — Constitution/Action/SessionInput types, assemble(), applyAction()
 *   @mainspring/brains     — MockBrain, a deterministic, scripted Brain
 *   @mainspring/governance — CONSTITUTION.md -> Rule[], evaluate() gates every Action
 *   @mainspring/ledger     — appendLedger()/readLedger(), the invariant-checked LEDGER.csv
 *   @mainspring/memory     — compactState(), appendJournal()/appendSession(), STATE.md + journal + session log
 *   @mainspring/scrub      — scan()/substitute(), the pre-publish secret-redaction gate
 *   @mainspring/relay      — MockRelay, the human-in-the-loop file -> resolve loop
 *
 * Mirrors the shape of examples/quickstart (assemble -> brain.step ->
 * governance.evaluate -> dispatch -> memory), extended with a relay hand-off
 * for a human-only blocker and a scrub pass on an outbound draft. No
 * network, no real spend: this proves the wiring, not a business.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { loadConstitutionRules, evaluate, type FiredRule, type Verdict } from "@mainspring/governance";
import { appendLedger, readLedger } from "@mainspring/ledger";
import { appendJournal, appendSession, compactState, journalPath, sessionLogPath } from "@mainspring/memory";
import { scan, substitute, type Finding } from "@mainspring/scrub";
import { MockRelay } from "@mainspring/relay";

// Secret-shaped test fixtures, built from concatenated fragments so no
// contiguous secret-shaped literal appears anywhere in this source file
// (same convention @mainspring/scrub's own tests use). Neither value is a
// real credential.
const FAKE_STRIPE_TEST_KEY = "sk" + "_test_" + "4eC39HqLyjWDarjtT1zdp7dcREDACTED0";
const FAKE_AWS_ACCESS_KEY = "AK" + "IA" + "IOSFODNN7EXAMPLE";

export const CONSTITUTION_MD = `# CONSTITUTION — Full-Stack Test Business

## Mission
Prove the whole Mainspring stack composes end to end, offline, with zero credentials.

## Hard rules
1. Legal and honest only.
2. You are an AI and never claim otherwise when posting or publishing. <!-- rule:honesty-disclosure -->
3. Secrets never appear in a write, notification, or tool call. <!-- rule:no-secrets -->
4. Every dollar of spend respects the session's caps; over-cap spend needs the owner. <!-- rule:spend-caps -->
5. Only pre-approved tools may be called from a session. <!-- rule:external-allowlist -->
`;

export const constitution: Constitution = {
  name: "Full-Stack Test Business",
  mission: "Prove the whole Mainspring stack composes end to end, offline, with zero credentials.",
  hardRules: [
    "Legal and honest only.",
    "You are an AI and never claim otherwise when posting or publishing.",
    "Secrets never appear in a write, notification, or tool call.",
    "Every dollar of spend respects the session's caps; over-cap spend needs the owner.",
    "Only pre-approved tools may be called from a session.",
  ],
  moneyCaps: { perSessionUsd: 50, notifyAboveUsd: 20, approvalAboveUsd: 75 },
  maxSessionMs: 40 * 60 * 1000,
};

const tools: ToolSpec[] = [];

/** A STATE.md with a head plus 8 dated session-log entries — deliberately too long for a 40-line budget. */
function buildOversizedState(): string {
  const head = [
    "# Full-Stack Test Business",
    "",
    "## Status",
    "Building the mainspring-pack landing page.",
    "",
    "## Next up",
    "Ship the launch draft once scrub clears it.",
    "",
    "## Session log",
    "",
  ];
  const entries: string[] = [];
  for (let day = 1; day <= 8; day++) {
    entries.push(`### session ${day}`, `- did some work on day ${day}`, "- shipped nothing dramatic", "- balance unchanged", "");
  }
  return [...head, ...entries].join("\n");
}

/**
 * A scripted 6-step business day: (1) an allowed write + notify, (2) an
 * allowed small expense, (3) an over-cap expense governance must block, (4) a
 * write containing a leaked secret governance must block, (5) a relay hand-off
 * for something only a human can do, and (6) a real sale plus `done`.
 */
function buildScript(): StepResult[] {
  const usage = { inputTokens: 0, outputTokens: 0, wallMs: 0 };
  const now = () => new Date().toISOString();

  return [
    {
      done: false,
      usage,
      actions: [
        { kind: "notify", to: "owner", text: "Full-stack session started: drafting the mainspring-pack product page, no spend yet." },
        {
          kind: "write",
          path: "notes/product.md",
          content: "# Mainspring Pack landing copy\n\nHonest, AI-authored product copy. No fake reviews, no impersonation.\n",
        },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        { kind: "ledger", entry: { date: now(), type: "expense", description: "VPS hosting reimbursement", amountUsd: 15 } },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        { kind: "ledger", entry: { date: now(), type: "expense", description: "Impulse ad spend test", amountUsd: 999 } },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        {
          kind: "write",
          path: "notes/leaked.md",
          content: `Internal debug note — STRIPE_API_KEY=${FAKE_STRIPE_TEST_KEY}\n`,
        },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        {
          kind: "relay",
          request: {
            id: "rl-product-hunt",
            summary: "Create a Product Hunt account for launch",
            detail: "Sign-up requires a CAPTCHA the agent cannot clear; a human needs to create the account by hand.",
            createdAt: now(),
          },
        },
      ],
    },
    {
      done: true,
      usage,
      actions: [
        { kind: "ledger", entry: { date: now(), type: "revenue", description: "First sale: agent-kit", amountUsd: 29 } },
        { kind: "done" },
      ],
    },
  ];
}

export interface ActionTrace {
  action: Action;
  verdict: Verdict;
  firedRules: FiredRule[];
  applied: boolean;
  detail: string;
}

export interface StepTrace {
  step: number;
  actions: ActionTrace[];
}

export interface RelayTrace {
  requestId: string;
  mockId: string;
  filedTitle: string;
  resolvedStatus: string;
  resolvedResult: string | null;
}

export interface ScrubTrace {
  findingsBeforeRedaction: Finding[];
  findingsAfterRedaction: Finding[];
  redactedContent: string;
}

export interface StateTrace {
  seededContent: string;
  compactedContent: string;
  droppedEntries: number;
}

export interface FullStackResult {
  workspaceDir: string;
  steps: StepTrace[];
  ledgerBalanceUsd: number;
  ledgerEntryCount: number;
  journalFile: string;
  sessionLogFile: string;
  relay: RelayTrace;
  scrub: ScrubTrace;
  state: StateTrace;
  /** `SessionInput.budget.remainingUSD` as `assemble()` computed it at the top of each step — proves core re-reads what ledger just wrote. */
  budgetRemainingUsdByStep: number[];
  /** `SessionInput.state` as `assemble()` read it at step 1 — proves it's exactly what compactState() produced, round-tripped through disk. */
  assembledStateAtStep1: string;
}

/**
 * Runs the scripted session against `workspaceDir`: assemble -> brain.step ->
 * governance.evaluate -> dispatch (ledger package for money, relay package
 * for human hand-offs, core's dispatch for everything else) -> memory
 * (STATE.md compaction, journal, session log). A scrub pass over an outbound
 * draft runs after the loop, mirroring a real pre-publish gate. Swaps in the
 * governance, ledger, and relay packages instead of core's own built-in
 * gate/ledger-write/relay-write so all seven packages are exercised together.
 */
export async function runFullStackSession(workspaceDir: string): Promise<FullStackResult> {
  const seededContent = buildOversizedState();
  const { content: compactedContent, dropped } = compactState(seededContent, 40);
  await writeFile(join(workspaceDir, "STATE.md"), compactedContent, "utf8");

  const brain = new MockBrain(buildScript());
  const relay = new MockRelay();
  const history: Turn[] = [];
  const steps: StepTrace[] = [];
  const today = new Date().toISOString().slice(0, 10);

  let spentSoFarUsd = 0;
  let stepNumber = 0;
  let done = false;
  let relayTrace: RelayTrace | null = null;
  const budgetRemainingUsdByStep: number[] = [];
  let assembledStateAtStep1 = "";

  while (!done) {
    stepNumber += 1;
    const input = await assemble(workspaceDir, constitution, tools);
    budgetRemainingUsdByStep.push(input.budget.remainingUSD);
    if (stepNumber === 1) assembledStateAtStep1 = input.state;
    const stepResult = await brain.step(input, history);

    const { rules } = loadConstitutionRules(CONSTITUTION_MD, {
      moneyCaps: constitution.moneyCaps,
      spentSoFarUsd,
      approvalCodePresent: false,
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
        } else if (action.kind === "relay") {
          const mockId = await relay.fileRequest({ title: action.request.summary, detail: action.request.detail });
          const resolved = relay.resolve(mockId, "owner created the account by hand; no credentials returned to the agent");
          applied = true;
          detail = `filed relay request ${mockId} and it was resolved as "${resolved.status}"`;
          relayTrace = {
            requestId: action.request.id,
            mockId,
            filedTitle: action.request.summary,
            resolvedStatus: resolved.status,
            resolvedResult: resolved.result,
          };
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
      [`### step ${stepNumber}`, ...stepTrace.actions.map((a) => `- [${a.verdict}] ${a.action.kind}: ${a.detail}`)].join("\n"),
    );

    history.push({ role: "brain", content: JSON.stringify(stepResult.actions), at: new Date().toISOString() });
    steps.push(stepTrace);
    done = stepResult.done;
  }

  if (!relayTrace) {
    throw new Error("full-stack session script never filed a relay request");
  }

  await appendSession(workspaceDir, {
    ts: new Date().toISOString(),
    steps: steps.length,
    actions: steps.reduce((sum, s) => sum + s.actions.length, 0),
    outcome: "done",
  });

  // Pre-publish scrub gate: an outbound draft leaked a fake AWS key. scan()
  // must find it; substitute() must redact it; the redacted draft must then
  // pass the SAME governance no-secrets guard the raw draft would have failed.
  const draft = `Launch note: rotate the old key ${FAKE_AWS_ACCESS_KEY} before announcing. Mainspring Pack is live!`;
  const findingsBeforeRedaction = scan(draft);
  const redactedContent = substitute(draft, { OLD_AWS_KEY: FAKE_AWS_ACCESS_KEY });
  const findingsAfterRedaction = scan(redactedContent);

  const publishAction: Action = { kind: "write", path: "outbox/launch-draft.md", content: redactedContent };
  const { rules: publishRules } = loadConstitutionRules(CONSTITUTION_MD, {
    moneyCaps: constitution.moneyCaps,
    spentSoFarUsd,
    approvalCodePresent: false,
  });
  const publishVerdict = evaluate(publishAction, publishRules);
  if (publishVerdict.verdict !== "allow") {
    throw new Error(`redacted draft was still blocked by governance: ${JSON.stringify(publishVerdict.firedRules)}`);
  }
  await applyAction(publishAction, { workspaceDir });

  const ledger = await readLedger(workspaceDir);
  const finalState = await readFile(join(workspaceDir, "STATE.md"), "utf8");

  return {
    workspaceDir,
    steps,
    ledgerBalanceUsd: ledger.balance(),
    ledgerEntryCount: ledger.entries.length,
    journalFile: journalPath(workspaceDir, today),
    sessionLogFile: sessionLogPath(workspaceDir),
    relay: relayTrace,
    scrub: { findingsBeforeRedaction, findingsAfterRedaction, redactedContent },
    state: { seededContent, compactedContent: finalState, droppedEntries: dropped },
    budgetRemainingUsdByStep,
    assembledStateAtStep1,
  };
}

function printTrace(result: FullStackResult): void {
  console.log(`Mainspring full-stack test — workspace: ${result.workspaceDir}\n`);
  for (const step of result.steps) {
    console.log(`Step ${step.step}:`);
    for (const a of step.actions) {
      const mark = a.verdict === "allow" ? "✓ ALLOWED" : `✗ ${a.verdict.toUpperCase()}`;
      console.log(`  ${mark}  ${a.action.kind}  ${a.detail}`);
    }
  }
  console.log(`\nLedger balance: $${result.ledgerBalanceUsd.toFixed(2)} across ${result.ledgerEntryCount} entries`);
  console.log(`Relay: ${result.relay.filedTitle} -> ${result.relay.resolvedStatus}`);
  console.log(`Scrub: ${result.scrub.findingsBeforeRedaction.length} finding(s) before redaction, ${result.scrub.findingsAfterRedaction.length} after`);
  console.log(`STATE.md: dropped ${result.state.droppedEntries} old session-log entr${result.state.droppedEntries === 1 ? "y" : "ies"} on compaction`);
  console.log(`Journal:     ${result.journalFile}`);
  console.log(`Session log: ${result.sessionLogFile}`);
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-full-stack-test-"));
  const result = await runFullStackSession(workspaceDir);
  printTrace(result);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
