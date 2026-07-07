/**
 * Built-in constitutional rules.
 *
 * This module has zero runtime dependencies, including on @mainspring/core:
 * `Action` below is a structural re-declaration of core's Action union so
 * this package can be dropped into any workspace without a build-order
 * dependency. Any real core `Action` value satisfies this type as-is.
 */

/** Structural mirror of @mainspring/core's `Action` union — see packages/core/src/types.ts. */
export type Action =
  | { kind: "run"; tool: string; args: unknown }
  | { kind: "write"; path: string; content: string }
  | { kind: "ledger"; entry: { date: string; type: "revenue" | "expense" | "refund" | "adjustment"; description: string; amountUsd: number } }
  | { kind: "enqueue"; order: unknown }
  | { kind: "relay"; request: unknown }
  | { kind: "notify"; to: "owner"; text: string; priority?: "high" }
  | { kind: "done" };

export type Verdict = "allow" | "block" | "escalate";

export interface Rule {
  id: string;
  description: string;
  test(action: Action): Verdict;
}

/** Money policy a workspace's Constitution sets — mirrors core's `MoneyCaps`. */
export interface MoneyCaps {
  perSessionUsd: number;
  notifyAboveUsd: number;
  approvalAboveUsd: number;
}

export interface GovernanceConfig {
  /** Enforced by the `spend-caps` rule. Omit to leave spend ungoverned by this rule. */
  moneyCaps?: MoneyCaps;
  /** Running total of expense actions already applied so far this session. */
  spentSoFarUsd?: number;
  /** Whether the current session carries an owner-supplied approval code. */
  approvalCodePresent?: boolean;
  /**
   * Enforced by the `external-allowlist` rule: `run` actions whose `tool` is
   * not in this list are blocked. Omit to leave `run` ungoverned by this rule
   * (e.g. when a workspace enforces tool access elsewhere, as core's gate does).
   */
  allowedTools?: string[];
  /**
   * Enforced by the `honesty-disclosure` rule: a `run` action whose `tool`
   * matches this pattern is treated as posting/publishing to an external
   * audience, and its `args` must carry `disclosedAsAI: true`.
   */
  postToolPattern?: RegExp;
}

const DEFAULT_POST_TOOL_PATTERN = /post|publish|tweet|comment|reply|reddit|hn|hacker-?news/i;

/** Belt-and-braces secret-shape check. Coarser than @mainspring/scrub by design —
 * this rule exists to catch an obviously leaking Action, not to replace a scrub pass. */
const SECRET_LIKE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN)\s*=\s*\S+/,
  /\bAWS_[A-Z_]*=\s*\S+/,
];

/**
 * Zero-width/format characters (ZWSP, ZWNJ, ZWJ, word joiner, bidi overrides,
 * BOM, soft hyphen) have no visible glyph but split a contiguous secret
 * literal for regex purposes — e.g. "sk_live_" + ZWSP + "4eC39..." reads
 * identically to a human but no longer matches `[A-Za-z0-9]{16,}`. Strip them
 * before pattern matching so this can't be used to smuggle a secret past the
 * shape check.
 */
const INVISIBLE_CHARS = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]",
  "g",
);

function looksLikeSecret(content: string): boolean {
  const normalized = content.replace(INVISIBLE_CHARS, "");
  return SECRET_LIKE_PATTERNS.some((re) => re.test(normalized));
}

/**
 * `run.args` is attacker-influenced and may be a hostile object built
 * directly (not via JSON, which cannot fabricate a real prototype chain) —
 * e.g. `{ text: "hi", __proto__: { secret: "sk_live_..." } }`. JSON.stringify
 * only serializes *own* enumerable properties, so a value placed on the
 * prototype is invisible to it while still readable via normal property
 * access (`args.secret`). A `for...in` loop walks the prototype chain, so
 * appending its output catches values hidden this way.
 */
function stringifyIncludingInherited(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const key in value as Record<string, unknown>) {
      text += ` ${key}=${String((value as Record<string, unknown>)[key])}`;
    }
  }
  return text;
}

function textCarriedBy(action: Action): string | null {
  switch (action.kind) {
    case "write":
      return action.content;
    case "notify":
      return action.text;
    case "run":
      return stringifyIncludingInherited(action.args);
    default:
      return null;
  }
}

/**
 * Hard rule 4: "Secrets live in .env only. Never put them in git, journals,
 * messages, or any website except the named service's own official domain."
 * Applies to every Action kind that can carry free-form outbound text.
 */
function noSecretsRule(): Rule {
  return {
    id: "no-secrets",
    description: "No secret-shaped strings may leave via a write, notify, or run/publish action.",
    test(action) {
      const text = textCarriedBy(action);
      if (text === null) return "allow";
      return looksLikeSecret(text) ? "block" : "allow";
    },
  };
}

/**
 * Delegates the actual threshold decision to a small, independently testable
 * SpendPolicy-shaped check, per the work order's "delegates to a SpendPolicy-
 * like check" note.
 */
export function checkSpendPolicy(
  entry: { type: "revenue" | "expense" | "refund" | "adjustment"; amountUsd: number },
  caps: MoneyCaps,
  spentSoFarUsd: number,
  approvalCodePresent: boolean,
): Verdict {
  if (entry.type !== "expense") return "allow";
  // Fail closed on a malformed amount. A compromised brain builds Action
  // objects directly (not via JSON, which has no NaN/Infinity), so a garbage
  // amountUsd can reach here — and NaN / -Infinity compare false against every
  // threshold below, which would silently return "allow". Deny outright; not
  // even an approval code clears an amount the guard cannot reason about.
  if (!Number.isFinite(entry.amountUsd)) return "block";
  // core's LedgerEntry contract says amountUsd is "a positive number; sign is
  // implied by type" — a non-positive "expense" is already off-contract. Left
  // unblocked, a negative expense would silently *reduce* the caller's running
  // spentSoFarUsd total on the next session, letting a compromised brain bank
  // a negative balance to hide a later large expense under the per-session cap.
  if (entry.amountUsd <= 0) return "block";
  const projected = spentSoFarUsd + entry.amountUsd;
  if (projected > caps.perSessionUsd) return "block";
  if (entry.amountUsd >= caps.approvalAboveUsd) {
    // An approval code clears the approval gate outright — it supersedes the
    // lower notify-only threshold rather than falling through to it.
    return approvalCodePresent ? "allow" : "escalate";
  }
  if (entry.amountUsd >= caps.notifyAboveUsd) return "escalate";
  return "allow";
}

/**
 * Money rule: "under $25 proceed with logged justification; $25-75 notify
 * first; over $75 requires the owner replying with the approval code."
 */
function spendCapsRule(config: GovernanceConfig): Rule {
  return {
    id: "spend-caps",
    description: "Expense ledger entries must respect the per-session cap and the notify/approval thresholds.",
    test(action) {
      if (action.kind !== "ledger") return "allow";
      if (!config.moneyCaps) return "allow";
      return checkSpendPolicy(action.entry, config.moneyCaps, config.spentSoFarUsd ?? 0, config.approvalCodePresent ?? false);
    },
  };
}

/**
 * External-action allowlist: a `run` action names a tool the brain wants
 * executed outside the workspace. If a workspace declares an allowlist, any
 * tool not on it is blocked outright — the brain cannot invent a new
 * external capability for itself.
 */
function externalAllowlistRule(config: GovernanceConfig): Rule {
  return {
    id: "external-allowlist",
    description: "A `run` action's tool must be in the workspace's declared external-action allowlist.",
    test(action) {
      if (action.kind !== "run") return "allow";
      if (!config.allowedTools) return "allow";
      return config.allowedTools.includes(action.tool) ? "allow" : "block";
    },
  };
}

/**
 * Hard rule 2: "You are an AI and never claim otherwise." Any run action that
 * looks like it posts/publishes to an external audience must carry an
 * explicit AI-disclosure flag in its args.
 */
function honestyDisclosureRule(config: GovernanceConfig): Rule {
  const pattern = config.postToolPattern ?? DEFAULT_POST_TOOL_PATTERN;
  return {
    id: "honesty-disclosure",
    description: "A post/publish-shaped run action must carry args.disclosedAsAI === true.",
    test(action) {
      if (action.kind !== "run") return "allow";
      if (!pattern.test(action.tool)) return "allow";
      const args = action.args;
      // Must be an *own* property: an object literal like `{ __proto__: {
      // disclosedAsAI: true } }` sets the object's real prototype (a JS
      // object-literal special case, unlike JSON.parse), so plain property
      // access (`args.disclosedAsAI`) walks the chain and reads `true` from
      // the prototype even though the action never actually declared it.
      const disclosed =
        typeof args === "object" &&
        args !== null &&
        Object.prototype.hasOwnProperty.call(args, "disclosedAsAI") &&
        (args as Record<string, unknown>).disclosedAsAI === true;
      return disclosed ? "allow" : "block";
    },
  };
}

const PATH_TRAVERSAL_SEGMENT = /(^|[/\\])\.\.([/\\]|$)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * A `write` action's path must stay inside the workspace: no `..` segments
 * (relative escape), no absolute paths or `~` (escape via a rooted path), and
 * no embedded NUL (some filesystem APIs truncate a path at NUL, letting the
 * visible-looking suffix hide the real target). Unlike `content`, `path` was
 * previously ungoverned by any built-in rule.
 */
function pathTraversalRule(): Rule {
  return {
    id: "path-traversal",
    description: "A write action's path must stay within the workspace — no `..` segments, absolute paths, `~`, or NUL bytes.",
    test(action) {
      if (action.kind !== "write") return "allow";
      const path = action.path;
      if (typeof path !== "string" || path.length === 0) return "block";
      if (path.includes("\0")) return "block";
      if (PATH_TRAVERSAL_SEGMENT.test(path)) return "block";
      if (path.startsWith("/") || path.startsWith("~") || WINDOWS_DRIVE.test(path)) return "block";
      return "allow";
    },
  };
}

/** Builds the full built-in rule set, closing over the workspace's live policy config. */
export function createBuiltInRules(config: GovernanceConfig = {}): Rule[] {
  return [
    noSecretsRule(),
    spendCapsRule(config),
    externalAllowlistRule(config),
    honestyDisclosureRule(config),
    pathTraversalRule(),
  ];
}
