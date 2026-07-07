import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Action, DispatchResult, LedgerEntry } from "./types.js";

/**
 * Optional handlers for `run` Actions, keyed by ToolSpec name. A brain only
 * ever sees the declarative ToolSpec (name/description/argsSchema); the
 * handler that actually performs the call lives here, on the trusted side
 * of the loop, and is supplied by whoever wires up the workspace.
 */
export type ToolRegistry = Record<string, (args: unknown) => Promise<unknown>>;

export interface DispatchContext {
  workspaceDir: string;
  toolRegistry?: ToolRegistry;
}

function ledgerDelta(entry: LedgerEntry): number {
  switch (entry.type) {
    case "revenue":
      return entry.amountUsd;
    case "expense":
    case "refund":
      return -entry.amountUsd;
    case "adjustment":
      return 0;
  }
}

function csvEscape(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

async function lastBalance(ledgerPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return 0;
  const last = lines[lines.length - 1];
  const cols = last.split(",");
  const balance = Number(cols[cols.length - 1]);
  return Number.isFinite(balance) ? balance : 0;
}

async function ensureLedgerHeader(ledgerPath: string): Promise<void> {
  try {
    await readFile(ledgerPath, "utf8");
  } catch {
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "date,type,description,amount,balance\n", "utf8");
  }
}

/**
 * Applies one gate-allowed Action to the workspace on disk. This is the only
 * module in Mainspring that performs a filesystem write. It assumes the
 * caller (loop.ts) already ran the Action through gate.ts.
 */
export async function applyAction(action: Action, ctx: DispatchContext): Promise<DispatchResult> {
  switch (action.kind) {
    case "write": {
      const target = resolve(ctx.workspaceDir, action.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, action.content, "utf8");
      return { action, applied: true, detail: `wrote ${action.path}` };
    }

    case "ledger": {
      const ledgerPath = join(ctx.workspaceDir, "LEDGER.csv");
      await ensureLedgerHeader(ledgerPath);
      const prevBalance = await lastBalance(ledgerPath);
      const balance = prevBalance + ledgerDelta(action.entry);
      const row = [
        action.entry.date,
        action.entry.type,
        csvEscape(action.entry.description),
        action.entry.amountUsd.toFixed(2),
        balance.toFixed(2),
      ].join(",");
      await appendFile(ledgerPath, `${row}\n`, "utf8");
      return { action, applied: true, detail: `ledger balance now $${balance.toFixed(2)}` };
    }

    case "enqueue": {
      const path = join(ctx.workspaceDir, "queue", `${action.order.id}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(action.order, null, 2), "utf8");
      return { action, applied: true, detail: `enqueued ${action.order.id}` };
    }

    case "relay": {
      const path = join(ctx.workspaceDir, "relay", "pending", `${action.request.id}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(action.request, null, 2), "utf8");
      return { action, applied: true, detail: `filed relay request ${action.request.id}` };
    }

    case "notify": {
      const path = join(ctx.workspaceDir, "outbox", "notifications.log");
      await mkdir(dirname(path), { recursive: true });
      const line = `${new Date().toISOString()} [${action.priority ?? "normal"}] ${action.text}\n`;
      await appendFile(path, line, "utf8");
      return { action, applied: true, detail: "queued in outbox/notifications.log" };
    }

    case "run": {
      const handler = ctx.toolRegistry?.[action.tool];
      if (!handler) {
        return { action, applied: false, detail: `no handler registered for tool "${action.tool}"` };
      }
      const result = await handler(action.args);
      return { action, applied: true, detail: `ran ${action.tool}: ${JSON.stringify(result)}` };
    }

    case "done":
      return { action, applied: true, detail: "session marked done" };

    default: {
      const exhaustive: never = action;
      return { action: exhaustive, applied: false, detail: "unknown action kind" };
    }
  }
}

export async function applyActions(actions: Action[], ctx: DispatchContext): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  for (const action of actions) {
    results.push(await applyAction(action, ctx));
  }
  return results;
}

/** Path helper reused by loop.ts to keep "does this touch the workspace" logic in one place. */
export function isWithinWorkspace(workspaceDir: string, targetPath: string): boolean {
  const resolved = resolve(workspaceDir, targetPath);
  const root = resolve(workspaceDir) + sep;
  return resolved.startsWith(root);
}
