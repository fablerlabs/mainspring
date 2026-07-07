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
 * An id (WorkOrder.id / RelayRequest.id) is turned into a filename by
 * dispatch.ts (`join(workspaceDir, "queue", `${id}.json`)`). Because that path
 * is built from the id verbatim, an id containing path separators or `..`
 * would let an enqueue/relay Action escape the workspace — so the gate
 * constrains ids to a safe, filename-only charset. Fail-CLOSED: anything that
 * isn't an obviously safe id is blocked.
 */
function isSafeId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}

/**
 * The brain is untrusted by contract, so before the gate reasons about an
 * Action's *content* it confirms the Action is even structurally well-formed.
 * A malformed Action (missing or mistyped required field) is blocked here —
 * fail-CLOSED — rather than thrown through gateAction (which would crash the
 * whole session and skip every other queued Action) or silently passed (which
 * would, e.g., sneak a `write` with a non-string `content` past the secret
 * scan and on into dispatch). Returns a reason when malformed, else null.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function structuralReason(action: Action): string | null {
  // The declared Action type promises these fields exist, but the brain is
  // untrusted, so inspect through an untyped view rather than trusting the union.
  const a = action as unknown as Record<string, unknown>;
  switch (action.kind) {
    case "write":
      if (typeof a.path !== "string" || a.path.length === 0) {
        return "write action is missing a valid string `path`";
      }
      if (typeof a.content !== "string") {
        return "write action is missing a valid string `content`";
      }
      return null;
    case "ledger": {
      if (!isObject(a.entry)) {
        return "ledger action is missing a valid `entry`";
      }
      if (typeof a.entry.amountUsd !== "number" || !Number.isFinite(a.entry.amountUsd)) {
        return "ledger entry `amountUsd` must be a finite number";
      }
      if (typeof a.entry.type !== "string") {
        return "ledger entry `type` must be a string";
      }
      return null;
    }
    case "notify":
      if (typeof a.text !== "string") {
        return "notify action is missing a valid string `text`";
      }
      return null;
    case "run":
      if (typeof a.tool !== "string" || a.tool.length === 0) {
        return "run action is missing a valid string `tool`";
      }
      return null;
    case "enqueue":
      if (!isObject(a.order) || !isSafeId(a.order.id)) {
        return "enqueue action is missing a valid `order` with a filename-safe string `id`";
      }
      return null;
    case "relay":
      if (!isObject(a.request) || !isSafeId(a.request.id)) {
        return "relay action is missing a valid `request` with a filename-safe string `id`";
      }
      return null;
    case "done":
      return null;
    default:
      return null; // an unknown kind is caught by gateAction's exhaustive default
  }
}

/**
 * Validates a single proposed Action against the Constitution. Nothing is
 * ever executed here — this only decides allow/block and why. dispatch.ts
 * is the only module allowed to act on an `allowed: true` decision.
 */
export function gateAction(action: Action, ctx: GateContext): GateDecision {
  const malformed = structuralReason(action);
  if (malformed) {
    return { action, allowed: false, reason: malformed };
  }

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
