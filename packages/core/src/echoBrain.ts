import type { Action, Brain, Money, SessionInput, StepResult, Turn, Usage } from "./types.js";

/**
 * A deterministic, zero-API-key Brain. It does no reasoning: it always
 * appends one journal line and one $0 ledger heartbeat, then reports done.
 * Its only job is to prove the loop — assemble -> gate -> dispatch -> commit
 * — works end to end with no network access and no credentials, so a new
 * workspace is runnable before anyone wires up a real model.
 */
export class EchoBrain implements Brain {
  readonly id = "echo";
  readonly model = "echo-deterministic";

  async step(input: SessionInput, history: Turn[]): Promise<StepResult> {
    const already = history.some((t) => t.role === "brain");
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);

    if (already) {
      return { actions: [{ kind: "done" }], usage: zeroUsage(), done: true };
    }

    const journalPrefix = input.journalTail || `# Journal — ${today}\n\n`;
    const journalContent = `${journalPrefix}- ${nowIso} EchoBrain ran a heartbeat session (no-op business logic).\n`;

    const actions: Action[] = [
      {
        kind: "write",
        path: `journal/${today}.md`,
        content: journalContent,
      },
      {
        kind: "ledger",
        entry: {
          date: nowIso,
          type: "adjustment",
          description: "echo heartbeat (no real spend)",
          amountUsd: 0,
        },
      },
      { kind: "done" },
    ];

    return { actions, usage: zeroUsage(), done: true };
  }

  estimateCost(_usage: Usage): Money {
    return { usd: 0 };
  }
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, wallMs: 0 };
}
