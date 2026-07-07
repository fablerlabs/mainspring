import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assemble } from "./assemble.js";
import { applyActions, type BrokerLike } from "./dispatch.js";
import { gateActions } from "./gate.js";
import type { Brain, Constitution, SessionSummary, ToolSpec, Turn } from "./types.js";

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
  const { workspaceDir, constitution, brain, tools = [], broker, maxSteps = 25, commit = true } = options;
  const startedAt = new Date().toISOString();
  const history: Turn[] = [];

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
    });

    const allowedActions = decisions.filter((d) => d.allowed).map((d) => d.action);
    for (const decision of decisions) {
      if (decision.allowed) {
        actionsAllowed += 1;
        if (decision.action.kind === "ledger" && decision.action.entry.type === "expense") {
          spentUsd += decision.action.entry.amountUsd;
        }
      } else {
        actionsBlocked += 1;
        blockedReasons.push(decision.reason ?? "blocked with no reason given");
      }
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

  const summaryDir = join(workspaceDir, ".mainspring");
  await mkdir(summaryDir, { recursive: true });
  await writeFile(join(summaryDir, "last-session.json"), JSON.stringify({ ...summary, commitDetail }, null, 2), "utf8");

  return summary;
}
