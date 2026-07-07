import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assemble } from "./assemble.js";
import { applyActions, type BrokerLike } from "./dispatch.js";
import { gateActions, type GovernanceGuard } from "./gate.js";
import { SpendGate, type SpendAudit } from "./spendGate.js";
import type { SpendPolicy } from "@mainspring/ledger";
import type { Action, Brain, Constitution, SessionSummary, ToolSpec, Turn } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RunSessionOptions {
  workspaceDir: string;
  constitution: Constitution;
  brain: Brain;
  tools?: ToolSpec[];
  /**
   * Optional capability broker. When provided, dispatch routes every
   * money-moving/external Action through it for caps/allowlist/audit before
   * applying the effect. Omit it and the loop behaves exactly as before.
   */
  broker?: BrokerLike;
  /**
   * Optional constitution-as-code guard (built from `@mainspring/governance`).
   * When provided, every Action the built-in gate would allow is additionally
   * checked against it before dispatch; a hard-rule violation denies with the
   * constitution citation. Omit it and the loop behaves exactly as before.
   */
  governance?: GovernanceGuard;
  /**
   * Optional policy-tier spend gate. When set, every gate-allowed Action that
   * carries a spend amount (an `expense` ledger line, or a `run` whose args
   * include `amountUsd`) is classified via `@mainspring/ledger`'s `checkSpend`
   * against this policy BEFORE dispatch: an under-threshold spend proceeds, a
   * notify-band spend proceeds (the owner is owed a heads-up), and a
   * needs-approval spend is BLOCKED (fail-closed) unless `approvalCodePresent`
   * is true; a missing/non-finite/negative amount is also blocked. Every spend
   * attempt is audited (see `.mainspring/last-session.json`). Omit it and the
   * loop behaves exactly as before — the hard per-session cap in gate.ts still
   * applies either way; this is a second, finer layer on top of it.
   */
  spendPolicy?: SpendPolicy;
  /** Whether a valid owner approval code is present this session (see `spendPolicy`). */
  approvalCodePresent?: boolean;
  /** Safety valve independent of the brain's own `done` flag. */
  maxSteps?: number;
  /** Skip the `git add && git commit` at session end (used by tests). */
  commit?: boolean;
}

async function tryGitCommit(workspaceDir: string, message: string): Promise<string> {
  try {
    await execFileAsync("git", ["add", "-A"], { cwd: workspaceDir });
    const { stdout: diffStat } = await execFileAsync("git", ["diff", "--cached", "--stat"], { cwd: workspaceDir });
    if (!diffStat.trim()) {
      return "nothing to commit";
    }
    await execFileAsync("git", ["commit", "-m", message], { cwd: workspaceDir });
    return "committed";
  } catch (err) {
    return `commit skipped: ${(err as Error).message}`;
  }
}

/**
 * Runs one Mainspring session: assemble context, call the Brain in a loop,
 * gate every proposed Action against the Constitution, dispatch what's
 * allowed, then commit the workspace. This function is the whole trust
 * boundary — it is the only caller of gate.ts and dispatch.ts.
 */
export async function runSession(options: RunSessionOptions): Promise<SessionSummary> {
  const { workspaceDir, constitution, brain, tools = [], broker, governance, spendPolicy, approvalCodePresent, maxSteps = 25, commit = true } = options;
  const startedAt = new Date().toISOString();
  const history: Turn[] = [];

  // Second money layer: the policy-tier spend gate (opt-in via `spendPolicy`).
  // Constructed once so its audit trail accumulates across every step.
  const spendGate = spendPolicy ? new SpendGate({ policy: spendPolicy, approvalCodePresent }) : undefined;
  const spendNotices: string[] = [];

  let steps = 0;
  let actionsProposed = 0;
  let actionsAllowed = 0;
  let actionsBlocked = 0;
  let spentUsd = 0;
  const blockedReasons: string[] = [];
  let done = false;

  while (!done && steps < maxSteps) {
    const input = await assemble(workspaceDir, constitution, tools);
    const stepResult = await brain.step(input, history);
    steps += 1;
    actionsProposed += stepResult.actions.length;

    const decisions = gateActions(stepResult.actions, {
      constitution,
      workspaceDir,
      spentSoFarUsd: spentUsd,
      tools,
      governance,
    });

    const allowedActions: Action[] = [];
    for (const decision of decisions) {
      if (!decision.allowed) {
        actionsBlocked += 1;
        blockedReasons.push(decision.reason ?? "blocked with no reason given");
        continue;
      }
      // The Constitution gate said yes; now run the finer spend gate (if wired).
      // A "block" here (needs-approval / malformed amount) stops the Action
      // before dispatch; a "notify" proceeds but is recorded as owed an owner ping.
      if (spendGate) {
        const spend = spendGate.check(decision.action);
        if (spend.status === "block") {
          actionsBlocked += 1;
          blockedReasons.push(spend.reason);
          continue;
        }
        if (spend.status === "notify") {
          spendNotices.push(spend.reason);
        }
      }
      actionsAllowed += 1;
      if (decision.action.kind === "ledger" && decision.action.entry.type === "expense") {
        spentUsd += decision.action.entry.amountUsd;
      }
      allowedActions.push(decision.action);
    }

    await applyActions(allowedActions, { workspaceDir, broker });

    history.push({ role: "brain", content: JSON.stringify(stepResult.actions), at: new Date().toISOString() });
    done = stepResult.done || stepResult.actions.some((a) => a.kind === "done");
  }

  const commitDetail = commit ? await tryGitCommit(workspaceDir, "mainspring: session commit") : "commit disabled";

  const summary: SessionSummary = {
    startedAt,
    endedAt: new Date().toISOString(),
    steps,
    actionsProposed,
    actionsAllowed,
    actionsBlocked,
    blockedReasons,
    spentUsd,
    done,
  };

  const spendAudit: readonly SpendAudit[] = spendGate ? spendGate.audit : [];
  const summaryDir = join(workspaceDir, ".mainspring");
  await mkdir(summaryDir, { recursive: true });
  await writeFile(
    join(summaryDir, "last-session.json"),
    JSON.stringify({ ...summary, commitDetail, spendNotices, spendAudit }, null, 2),
    "utf8",
  );

  return summary;
}
