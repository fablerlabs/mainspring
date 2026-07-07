import assert from "node:assert/strict";
import { test } from "node:test";
import { gateAction, gateActions, type GateContext, type GovernanceGuard, type GovernanceResult } from "../src/index.js";
import type { Action, Constitution } from "../src/index.js";

/**
 * Wiring tests for the optional `@mainspring/governance` seam in gate.ts.
 * The seam is structural: the gate accepts an injected `GovernanceGuard`
 * (which a workspace builds from `@mainspring/governance`'s `evaluate` bound
 * to rules loaded from `CONSTITUTION.md`). These tests use hand-rolled guards
 * that satisfy the same structural shape, so `core` needs no runtime dependency
 * on `governance` to prove the wiring. Theme: governance is purely ADDITIVE —
 * it can tighten a built-in allow into a denial (with citation) but never
 * loosen a built-in denial, the default (no guard) path is untouched, and a
 * guard that throws on a malformed constitution fails CLOSED.
 */

const constitution: Constitution = {
  name: "Test Business",
  mission: "test",
  hardRules: ["Legal and honest only.", "You are an AI and never claim otherwise."],
  moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
  maxSessionMs: 40 * 60 * 1000,
};

/** A base context the built-in gate allows a plain `notify` through. */
function ctx(governance?: GovernanceGuard): GateContext {
  return { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [], governance };
}

const notifyAction: Action = { kind: "notify", to: "owner", text: "shipped the pack" };

/** Mirrors what `(action) => evaluate(action, rules)` returns when a hard rule blocks. */
const RESULT_ALLOW: GovernanceResult = { verdict: "allow", firedRules: [] };

test("no-rules default path: without a governance guard, behavior is unchanged", () => {
  const decision = gateAction(notifyAction, ctx());
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, undefined);
});

test("allow path: a governance guard that returns allow leaves the built-in allow intact", () => {
  let called = 0;
  const guard: GovernanceGuard = () => {
    called += 1;
    return RESULT_ALLOW;
  };
  const decision = gateAction(notifyAction, ctx(guard));
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, undefined);
  assert.equal(called, 1, "governance is consulted for an Action the built-in gate allows");
});

test("hard-rule deny: a block verdict turns a built-in allow into a denial with the constitution citation", () => {
  const guard: GovernanceGuard = () => ({
    verdict: "block",
    firedRules: [
      {
        id: "honesty-disclosure",
        description: 'A post/publish-shaped run action must carry args.disclosedAsAI === true. (constitution: "You are an AI and never claim otherwise.")',
        verdict: "block",
      },
    ],
  });
  const decision = gateAction(notifyAction, ctx(guard));
  assert.equal(decision.allowed, false);
  // The reason cites the fired rule's id, verdict, and the constitution prose the loader attached.
  assert.match(decision.reason ?? "", /governance denied this action/);
  assert.match(decision.reason ?? "", /\[block\] honesty-disclosure:/);
  assert.match(decision.reason ?? "", /constitution: "You are an AI and never claim otherwise\."/);
});

test("an escalate verdict also denies (the gate is binary; escalate fails safe as a block)", () => {
  const guard: GovernanceGuard = () => ({
    verdict: "escalate",
    firedRules: [{ id: "spend-caps", description: "Expense needs the owner approval code.", verdict: "escalate" }],
  });
  const decision = gateAction(
    { kind: "ledger", entry: { date: "2026-01-01T00:00:00.000Z", type: "expense", description: "ad spend", amountUsd: 10 } },
    ctx(guard),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /\[escalate\] spend-caps:/);
});

test("governance is NOT consulted for an Action the built-in gate already denies (never loosens a denial)", () => {
  let called = 0;
  const guard: GovernanceGuard = () => {
    called += 1;
    return RESULT_ALLOW; // would 'allow', but must not be given the chance to override a built-in block
  };
  // A write escaping the workspace is a hard built-in denial.
  const decision = gateAction({ kind: "write", path: "../../etc/passwd", content: "x" }, ctx(guard));
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /escapes workspace/);
  assert.equal(called, 0, "governance is skipped once the built-in gate has already denied");
});

test("malformed-constitution fail-closed: a governance guard that throws denies rather than passing the Action", () => {
  const guard: GovernanceGuard = () => {
    // Simulates a loader/evaluate blowing up on an unparseable CONSTITUTION.md.
    throw new Error("could not parse CONSTITUTION.md");
  };
  const decision = gateAction(notifyAction, ctx(guard));
  assert.equal(decision.allowed, false, "a thrown governance guard must fail CLOSED");
  assert.match(decision.reason ?? "", /governance evaluation failed; denying fail-closed/);
  assert.match(decision.reason ?? "", /could not parse CONSTITUTION\.md/);
});

test("a block verdict with no recorded fired rule still denies, citing the verdict itself", () => {
  const guard: GovernanceGuard = () => ({ verdict: "block", firedRules: [] });
  const decision = gateAction(notifyAction, ctx(guard));
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /governance blocked this action/);
});

test("gateActions threads the injected governance guard through every Action", () => {
  const guard: GovernanceGuard = (action) =>
    action.kind === "notify"
      ? { verdict: "block", firedRules: [{ id: "no-secrets", description: "no outbound leak", verdict: "block" }] }
      : RESULT_ALLOW;
  const actions: Action[] = [
    { kind: "write", path: "notes.md", content: "hello" },
    { kind: "notify", to: "owner", text: "status" },
  ];
  const decisions = gateActions(actions, ctx(guard));
  assert.equal(decisions[0].allowed, true, "write is allowed by both built-in and governance");
  assert.equal(decisions[1].allowed, false, "notify is denied by the governance guard");
  assert.match(decisions[1].reason ?? "", /\[block\] no-secrets:/);
});
