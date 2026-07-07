import { resolve, sep } from "node:path";
import type { Action, Constitution, GateDecision, ToolSpec } from "./types.js";

/**
 * The subset of `@mainspring/governance` the gate depends on, mirrored here
 * structurally so `core` keeps zero runtime dependencies — `governance` stays
 * a *type-only* dependency, and the two packages remain build-order-
 * independent (`governance` already mirrors core's `Action` the same way). A
 * real `governance` value satisfies these types as-is.
 */
export type GovernanceVerdict = "allow" | "block" | "escalate";

/** A single governance rule that fired (returned a non-`allow` verdict). Mirrors `@mainspring/governance`'s `FiredRule`. */
export interface GovernanceFiredRule {
  id: string;
  description: string;
  verdict: GovernanceVerdict;
}

/** Outcome of evaluating one Action against a governance rule set. Mirrors `@mainspring/governance`'s `GuardResult`. */
export interface GovernanceResult {
  verdict: GovernanceVerdict;
  firedRules: GovernanceFiredRule[];
}

/**
 * An optional, injected constitution-as-code evaluator. The workspace wiring
 * builds one by binding `@mainspring/governance`'s `evaluate` to a rule set
 * loaded from its `CONSTITUTION.md`:
 *
 * ```ts
 * import { loadConstitutionFile, evaluate } from "@mainspring/governance";
 * const { rules } = await loadConstitutionFile("./CONSTITUTION.md", config);
 * const governance: GovernanceGuard = (action) => evaluate(action, rules);
 * ```
 *
 * The gate consults it only for Actions its own built-in checks already
 * allow, so governance can add hard-rule restrictions but never loosen a
 * built-in denial. A real `governance` never throws (its `evaluate` catches a
 * misbehaving rule and returns `escalate`), but should one blow up anyway —
 * e.g. an unparseable constitution its loader couldn't handle — the gate
 * fails CLOSED and denies rather than letting the Action through.
 */
export type GovernanceGuard = (action: Action) => GovernanceResult;

export interface GateContext {
  constitution: Constitution;
  workspaceDir: string;
  /** Sum of expense amounts already dispatched so far in this session. */
  spentSoFarUsd: number;
  tools: ToolSpec[];
  /**
   * Optional constitution-as-code layer. When present, every Action the
   * built-in gate would allow is additionally checked against it; a `block`
   * or `escalate` verdict (or a thrown error) turns the allow into a denial
   * carrying the fired rules' constitution citations. Omit for exactly the
   * previous behavior — governance is purely additive.
   */
  governance?: GovernanceGuard;
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
 * Renders a governance denial as a single reason string in the same plain-text
 * shape the built-in checks use, citing every rule that fired (its verdict, id,
 * and description — the description carries any `(constitution: "…")` prose the
 * loader attached, which is the citation).
 */
function describeGovernanceDenial(result: GovernanceResult): string {
  const fired = result.firedRules.filter((r) => r.verdict !== "allow");
  if (fired.length === 0) {
    // A non-allow overall verdict with no fired rule recorded — cite the verdict itself.
    return `governance ${result.verdict}ed this action`;
  }
  const citations = fired.map((r) => `[${r.verdict}] ${r.id}: ${r.description}`).join("; ");
  return `governance denied this action — ${citations}`;
}

/**
 * The Constitution's built-in, always-on checks. Split out from `gateAction`
 * so the optional `@mainspring/governance` layer can be consulted on top
 * without duplicating this logic. Nothing is ever executed here — this only
 * decides allow/block and why.
 */
function gateActionBuiltIn(action: Action, ctx: GateContext): GateDecision {
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

/**
 * Validates a single proposed Action against the Constitution. Nothing is
 * ever executed here — this only decides allow/block and why. dispatch.ts
 * is the only module allowed to act on an `allowed: true` decision.
 *
 * The built-in checks run first and always. Then, only for an Action they
 * allow, an injected `@mainspring/governance` guard (if any) is consulted:
 * governance can add hard-rule restrictions but never loosen a built-in
 * denial. A `block`/`escalate` verdict turns the allow into a denial carrying
 * the fired rules' constitution citations; a governance guard that throws
 * fails CLOSED (denies) rather than letting the Action slip through.
 */
export function gateAction(action: Action, ctx: GateContext): GateDecision {
  const builtIn = gateActionBuiltIn(action, ctx);
  if (!builtIn.allowed || !ctx.governance) {
    return builtIn;
  }

  let result: GovernanceResult;
  try {
    result = ctx.governance(action);
  } catch (err) {
    return {
      action,
      allowed: false,
      reason: `governance evaluation failed; denying fail-closed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.verdict !== "allow") {
    return { action, allowed: false, reason: describeGovernanceDenial(result) };
  }
  return builtIn;
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
