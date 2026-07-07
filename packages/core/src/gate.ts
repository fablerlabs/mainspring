import { resolve, sep } from "node:path";
import type { Action, Constitution, GateDecision, ToolSpec } from "./types.js";

export interface GateContext {
  constitution: Constitution;
  workspaceDir: string;
  /** Sum of expense amounts already dispatched so far in this session. */
  spentSoFarUsd: number;
  tools: ToolSpec[];
}

const FORBIDDEN_WRITE_TARGETS = [".env", ".git"];

function isWithinWorkspace(workspaceDir: string, targetPath: string): boolean {
  const resolved = resolve(workspaceDir, targetPath);
  const root = resolve(workspaceDir) + sep;
  return resolved.startsWith(root);
}

function touchesForbiddenTarget(targetPath: string): boolean {
  return FORBIDDEN_WRITE_TARGETS.some(
    (name) => targetPath === name || targetPath.startsWith(`${name}/`) || targetPath.includes(`/${name}/`) || targetPath.includes(`/${name}`),
  );
}

/** Content patterns that look like a leaked secret. Belt-and-braces: brains hold no
 * secrets by contract, but the gate double-checks anything about to hit disk or a message. */
const SECRET_LIKE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\b[A-Za-z0-9_]*API_KEY\s*=\s*\S+/,
  /\b[A-Za-z0-9_]*SECRET\s*=\s*\S+/,
  /\bAWS_[A-Z_]*=\s*\S+/,
];

function looksLikeSecret(content: string): boolean {
  return SECRET_LIKE_PATTERNS.some((re) => re.test(content));
}

/**
 * Validates a single proposed Action against the Constitution. Nothing is
 * ever executed here — this only decides allow/block and why. dispatch.ts
 * is the only module allowed to act on an `allowed: true` decision.
 */
export function gateAction(action: Action, ctx: GateContext): GateDecision {
  switch (action.kind) {
    case "write": {
      if (!isWithinWorkspace(ctx.workspaceDir, action.path)) {
        return { action, allowed: false, reason: `write path escapes workspace: ${action.path}` };
      }
      if (touchesForbiddenTarget(action.path)) {
        return { action, allowed: false, reason: `write path targets a forbidden file: ${action.path}` };
      }
      if (looksLikeSecret(action.content)) {
        return { action, allowed: false, reason: "write content matches a secret-like pattern; blocked to prevent a leak" };
      }
      return { action, allowed: true };
    }

    case "ledger": {
      const { entry } = action;
      if (entry.amountUsd < 0) {
        return { action, allowed: false, reason: "ledger amountUsd must be non-negative; use `type` to express direction" };
      }
      if (entry.type === "expense") {
        const projected = ctx.spentSoFarUsd + entry.amountUsd;
        if (projected > ctx.constitution.moneyCaps.perSessionUsd) {
          return {
            action,
            allowed: false,
            reason: `expense of $${entry.amountUsd} would bring session spend to $${projected}, exceeding the per-session cap of $${ctx.constitution.moneyCaps.perSessionUsd}`,
          };
        }
      }
      return { action, allowed: true };
    }

    case "notify": {
      if (looksLikeSecret(action.text)) {
        return { action, allowed: false, reason: "notify text matches a secret-like pattern; blocked to prevent a leak" };
      }
      return { action, allowed: true };
    }

    case "run": {
      const known = ctx.tools.some((t) => t.name === action.tool);
      if (!known) {
        return { action, allowed: false, reason: `tool "${action.tool}" is not in the workspace's allowed tool list` };
      }
      return { action, allowed: true };
    }

    case "enqueue":
    case "relay":
    case "done":
      return { action, allowed: true };

    default: {
      const exhaustive: never = action;
      return { action: exhaustive, allowed: false, reason: "unknown action kind" };
    }
  }
}

export function gateActions(actions: Action[], ctx: GateContext): GateDecision[] {
  let runningSpend = ctx.spentSoFarUsd;
  const decisions: GateDecision[] = [];
  for (const action of actions) {
    const decision = gateAction(action, { ...ctx, spentSoFarUsd: runningSpend });
    decisions.push(decision);
    if (decision.allowed && action.kind === "ledger" && action.entry.type === "expense") {
      runningSpend += action.entry.amountUsd;
    }
  }
  return decisions;
}
