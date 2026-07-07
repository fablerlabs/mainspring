/**
 * Content-agent: a second worked example, distinct from quickstart, proving
 * Mainspring generalizes beyond a toy. Same five packages as quickstart plus
 * one more:
 *
 *   @mainspring/core       — Constitution/Action/SessionInput types, assemble()
 *   @mainspring/brains     — MockBrain, a deterministic, scripted Brain
 *   @mainspring/governance — CONSTITUTION.md -> Rule[], evaluate() gates every Action
 *   @mainspring/ledger     — appendLedger()/readLedger(), the tiny-budget ledger
 *   @mainspring/memory     — appendJournal()/appendSession(), durable session memory
 *   @mainspring/relay      — MockRelay + EchoResponder, the human-in-the-loop leg
 *
 * A scripted 5-step content-business day: draft a post, attempt to publish it
 * without the required AI-disclosure flag (governance blocks it by name),
 * file a relay request asking a human to approve the disclosed publish, have
 * a human (the relay's EchoResponder stand-in) approve it, retry the publish
 * now disclosed (governance allows it), and record a small in-cap ledger
 * spend. No network, no secrets, no real spend or publish.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assemble,
  applyAction,
  type Action,
  type Constitution,
  type RelayRequest,
  type StepResult,
  type ToolSpec,
  type Turn,
} from "@mainspring/core";
import { MockBrain } from "@mainspring/brains";
import { loadConstitutionRules, evaluate, type FiredRule } from "@mainspring/governance";
import { appendLedger, readLedger } from "@mainspring/ledger";
import { appendJournal, appendSession, journalPath, sessionLogPath } from "@mainspring/memory";
import { MockRelay, EchoResponder, pollUntilResolved, type RelayRequestView } from "@mainspring/relay";

export const CONSTITUTION_MD = `# CONSTITUTION — Content-Agent Example Business

## Mission
Publish a short daily post, honestly disclosed as AI-written, on a shoestring
budget — proving Mainspring's governance and human-in-the-loop handoff, not a
real audience.

## Hard rules
1. Legal and honest only. <!-- rule:legal-honest -->
2. You are an AI and never claim otherwise when posting or publishing. <!-- rule:honesty-disclosure -->
3. Secrets never appear in a write, notification, or tool call. <!-- rule:no-secrets -->
4. Every dollar of spend respects the session's tiny cap; over-cap spend needs the owner. <!-- rule:spend-caps -->
5. Only pre-approved tools may be called from a session. <!-- rule:external-allowlist -->
6. Publishing to the public site is human-gated: file a relay request and wait
   for a person to approve before the disclosed publish may proceed.
`;

export const constitution: Constitution = {
  name: "Content-Agent Example Business",
  mission: "Publish a short daily post, honestly disclosed as AI-written, on a shoestring budget.",
  hardRules: [
    "Legal and honest only.",
    "You are an AI and never claim otherwise when posting or publishing.",
    "Secrets never appear in a write, notification, or tool call.",
    "Every dollar of spend respects the session's tiny cap; over-cap spend needs the owner.",
    "Only pre-approved tools may be called from a session.",
    "Publishing to the public site is human-gated: file a relay request and wait for approval.",
  ],
  moneyCaps: { perSessionUsd: 15, notifyAboveUsd: 5, approvalAboveUsd: 20 },
  maxSessionMs: 40 * 60 * 1000,
};

/** The one external tool this workspace knows about. */
const ALLOWED_TOOLS = ["publish-post"];
const tools: ToolSpec[] = [
  {
    name: "publish-post",
    description: "Publish today's post to the content site. Must carry args.disclosedAsAI === true.",
  },
];

const POST = {
  title: "Why small, honest AI businesses win",
  body: "A short, honest post: ship a real product, disclose the author, and let the work speak.",
};

/**
 * A scripted 5-step content-business day: (1) an allowed draft write +
 * notify, (2) a publish attempt missing the AI-disclosure flag — governance
 * must block it — (3) a relay request asking a human to approve the
 * disclosed publish, (4) the same publish retried now disclosed — governance
 * must allow it — and (5) a small in-cap ledger spend plus `done`.
 */
function buildScript(): StepResult[] {
  const usage = { inputTokens: 0, outputTokens: 0, wallMs: 0 };
  const now = () => new Date().toISOString();

  return [
    {
      done: false,
      usage,
      actions: [
        { kind: "notify", to: "owner", text: "Content-agent session started: drafting today's post, no spend yet." },
        {
          kind: "write",
          path: "drafts/post-1.md",
          content: `# ${POST.title}\n\n${POST.body}\n`,
        },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        { kind: "run", tool: "publish-post", args: { ...POST, disclosedAsAI: false } },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        {
          kind: "relay",
          request: {
            id: "publish-approval-1",
            summary: "Approve publishing today's post with its AI-disclosure footer",
            detail:
              "The content-agent drafted a post and wants to publish it publicly with the required AI-disclosure footer attached. Approve to let the disclosed publish proceed.",
            estimateMinutes: 2,
            createdAt: now(),
          },
        },
      ],
    },
    {
      done: false,
      usage,
      actions: [
        { kind: "run", tool: "publish-post", args: { ...POST, disclosedAsAI: true } },
      ],
    },
    {
      done: true,
      usage,
      actions: [
        {
          kind: "ledger",
          entry: { date: now(), type: "expense", description: "Stock photo license for published post", amountUsd: 4.5 },
        },
        { kind: "done" },
      ],
    },
  ];
}

/** Writes the disclosed (or, if governance ever let it through, undisclosed) post to disk. Only ever invoked on an allowed Action. */
function makeToolRegistry(workspaceDir: string): Record<string, (args: unknown) => Promise<unknown>> {
  return {
    "publish-post": async (args: unknown) => {
      const { title, body, disclosedAsAI } = args as { title: string; body: string; disclosedAsAI: boolean };
      const disclosure = disclosedAsAI
        ? "\n\n---\n_This post was written and published by an AI agent (Mainspring content-agent example)._\n"
        : "";
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const relativePath = join("outbox", "published", `${slug}.md`);
      const target = join(workspaceDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `# ${title}\n\n${body}${disclosure}`, "utf8");
      return { path: relativePath };
    },
  };
}

/** Files a relay request for `request`, has a human (the EchoResponder stand-in) resolve it, and waits for the terminal view. */
async function fileAndResolveRelay(
  relay: MockRelay,
  human: EchoResponder,
  request: RelayRequest,
): Promise<RelayRequestView> {
  const id = await relay.fileRequest({
    title: request.summary,
    detail: request.detail,
    params: { estimateMinutes: request.estimateMinutes ?? null, localId: request.id },
  });
  // Stands in for a person opening the relay portal and clicking "Approve".
  await human.runOnce();
  return pollUntilResolved(relay, id, { intervalMs: 5, maxWaitMs: 1000 });
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

export interface ContentAgentResult {
  workspaceDir: string;
  steps: StepTrace[];
  ledgerBalanceUsd: number;
  journalFile: string;
  sessionLogFile: string;
  relayRequestId: string;
  relayFinalStatus: string;
}

/**
 * Runs the scripted session against `workspaceDir`: assemble -> brain.step ->
 * governance.evaluate -> dispatch. Mirrors quickstart's shape but swaps in
 * the relay package (instead of core's built-in `relay` dispatch, which only
 * writes a JSON file) for the one action that needs a real human decision.
 */
export async function runContentAgent(workspaceDir: string): Promise<ContentAgentResult> {
  const brain = new MockBrain(buildScript());
  const relay = new MockRelay();
  const human = new EchoResponder(relay);
  const toolRegistry = makeToolRegistry(workspaceDir);
  const history: Turn[] = [];
  const steps: StepTrace[] = [];
  const today = new Date().toISOString().slice(0, 10);

  let spentSoFarUsd = 0;
  let stepNumber = 0;
  let done = false;
  let relayRequestId = "";
  let relayFinalStatus = "";

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
        } else if (action.kind === "relay") {
          const view = await fileAndResolveRelay(relay, human, action.request);
          relayRequestId = view.id;
          relayFinalStatus = view.status;
          applied = true;
          detail = `relay ${view.id} ${view.status}: ${view.result}`;
        } else if (action.kind === "run") {
          const dispatchResult = await applyAction(action, { workspaceDir, toolRegistry });
          applied = dispatchResult.applied;
          detail = dispatchResult.detail ?? "";
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
    relayRequestId,
    relayFinalStatus,
  };
}

function printTrace(result: ContentAgentResult): void {
  console.log(`Mainspring content-agent — workspace: ${result.workspaceDir}\n`);
  for (const step of result.steps) {
    console.log(`Step ${step.step}:`);
    for (const a of step.actions) {
      const mark = a.verdict === "allow" ? "✓ ALLOWED" : `✗ ${a.verdict.toUpperCase()}`;
      console.log(`  ${mark}  ${a.action.kind}  ${a.detail}`);
    }
  }
  console.log(`\nRelay request: ${result.relayRequestId} (${result.relayFinalStatus})`);
  console.log(`Ledger balance: $${result.ledgerBalanceUsd.toFixed(2)}`);
  console.log(`Journal:     ${result.journalFile}`);
  console.log(`Session log: ${result.sessionLogFile}`);
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-content-agent-"));
  const result = await runContentAgent(workspaceDir);
  printTrace(result);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
