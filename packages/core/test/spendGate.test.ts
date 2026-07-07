import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SPEND_POLICY, type SpendPolicy } from "@mainspring/ledger";
import { SpendGate, classifySpend } from "../src/spendGate.js";
import type { Action } from "../src/types.js";

/**
 * Unit tests for the policy-tier spend gate. These exercise the *real*
 * @mainspring/ledger `checkSpend` (imported through spendGate.ts) to prove the
 * bands are the ledger's, not an inline copy, and that the gate fails CLOSED on
 * a malformed amount and on a needs-approval spend with no approval code. A
 * fixed clock makes every audit timestamp deterministic.
 */

const FIXED = "2026-07-07T00:00:00.000Z";
const fixedClock = (): Date => new Date(FIXED);

const expense = (amountUsd: number, description = "vps-hosting"): Action => ({
  kind: "ledger",
  entry: { date: FIXED, type: "expense", description, amountUsd },
});

const spendRun = (amountUsd: unknown, tool = "stripe.charge"): Action => ({
  kind: "run",
  tool,
  args: { amountUsd },
});

// --- 1. under-cap allowed -----------------------------------------------------

test("under-cap: a $5 expense is allowed (proceed) and audited allowed=true", () => {
  const gate = new SpendGate({ clock: fixedClock });
  const decision = gate.check(expense(5));

  assert.equal(decision.status, "allow");
  assert.equal(decision.audit?.decision, "proceed");
  assert.equal(gate.audit.length, 1);
  assert.deepEqual(
    { capability: gate.audit[0].capability, op: gate.audit[0].op, amountUsd: gate.audit[0].amountUsd, allowed: gate.audit[0].allowed },
    { capability: "spend", op: "vps-hosting", amountUsd: 5, allowed: true },
  );
  assert.equal(gate.audit[0].timestamp, FIXED);
});

// --- 2. over-cap blocked ------------------------------------------------------

test("over-cap: a $500 expense needs approval, is BLOCKED, and is audited allowed=false with a citation", () => {
  const gate = new SpendGate({ clock: fixedClock });
  const decision = gate.check(expense(500));

  assert.equal(decision.status, "block");
  assert.equal(decision.audit?.decision, "needs-approval");
  assert.match(decision.reason, /needs the owner's approval code/);
  assert.match(decision.reason, /BLOCKED fail-closed/);
  assert.equal(gate.audit.length, 1);
  assert.equal(gate.audit[0].allowed, false);
});

// --- 3. notify band -----------------------------------------------------------

test("notify band: a $50 expense proceeds but is flagged notify, audited allowed=true", () => {
  const gate = new SpendGate({ clock: fixedClock });
  const decision = gate.check(expense(50));

  assert.equal(decision.status, "notify");
  assert.equal(decision.audit?.decision, "notify");
  assert.match(decision.reason, /notify band/);
  assert.equal(gate.audit.length, 1);
  assert.equal(gate.audit[0].allowed, true);
});

// --- 4. boundaries are inclusive on the stricter side (ledger's rule) ---------

test("boundaries: exactly $25 notifies, exactly $75 needs approval (matches ledger checkSpend)", () => {
  const gate = new SpendGate({ clock: fixedClock });
  assert.equal(gate.check(expense(25)).status, "notify");
  assert.equal(gate.check(expense(74.99)).status, "notify");
  assert.equal(gate.check(expense(75)).status, "block");
  assert.equal(gate.audit.length, 3);
});

// --- 5. fail-closed on malformed amounts --------------------------------------

test("fail-closed: NaN, Infinity, negative, and non-numeric spend amounts are all BLOCKED and audited", () => {
  const gate = new SpendGate({ clock: fixedClock });

  const nan = gate.check(spendRun(Number.NaN));
  assert.equal(nan.status, "block");
  assert.equal(nan.audit?.decision, "invalid");
  assert.equal(nan.audit?.amountUsd, undefined); // NaN isn't a meaningful amount to log

  const inf = gate.check(spendRun(Number.POSITIVE_INFINITY));
  assert.equal(inf.status, "block");

  const neg = gate.check(expense(-10));
  assert.equal(neg.status, "block");
  assert.equal(neg.audit?.decision, "invalid");
  assert.equal(neg.audit?.amountUsd, -10); // a finite (if invalid) amount is still recorded

  const str = gate.check(spendRun("20"));
  assert.equal(str.status, "block");
  assert.equal(str.audit?.decision, "invalid");

  // Every malformed attempt was audited as denied.
  assert.equal(gate.audit.length, 4);
  assert.ok(gate.audit.every((e) => e.allowed === false));
});

// --- 6. run action carrying amountUsd is classified as a spend ----------------

test("run spend: a run action whose args carry amountUsd is gated by the same bands", () => {
  const gate = new SpendGate({ clock: fixedClock });
  assert.equal(gate.check(spendRun(5)).status, "allow");
  assert.equal(gate.check(spendRun(500)).status, "block");
  assert.equal(gate.audit[0].op, "stripe.charge");
});

// --- 7. non-spend actions are a no-op (no audit) ------------------------------

test("non-spend: write/notify/done/revenue actions carry no spend and record no audit", () => {
  const gate = new SpendGate({ clock: fixedClock });
  const nonSpend: Action[] = [
    { kind: "write", path: "notes.md", content: "hi" },
    { kind: "notify", to: "owner", text: "ping" },
    { kind: "done" },
    { kind: "ledger", entry: { date: FIXED, type: "revenue", description: "sale", amountUsd: 24 } },
    { kind: "run", tool: "post-to-reddit", args: { text: "no amount here" } },
  ];
  for (const action of nonSpend) {
    const d = gate.check(action);
    assert.equal(d.status, "allow");
    assert.equal(d.audit, null);
  }
  assert.equal(gate.audit.length, 0);
});

// --- 8. approval code present lets a needs-approval spend proceed -------------

test("approval present: a needs-approval spend proceeds (audited allowed=true) when approvalCodePresent is set", () => {
  const gate = new SpendGate({ clock: fixedClock, approvalCodePresent: true });
  const decision = gate.check(expense(500));
  assert.equal(decision.status, "allow");
  assert.equal(decision.audit?.decision, "needs-approval");
  assert.equal(decision.audit?.allowed, true);
  assert.match(decision.reason, /an approval code is present/);
});

// --- 9. custom policy ---------------------------------------------------------

test("custom policy: a tighter policy shifts the bands; the audit reflects the custom thresholds", () => {
  const strict: SpendPolicy = { autoApproveUnder: 1, notifyUnder: 5, approvalCodeOver: 5 };
  const gate = new SpendGate({ clock: fixedClock, policy: strict });
  assert.equal(gate.check(expense(0.5)).status, "allow");
  assert.equal(gate.check(expense(2)).status, "notify");
  assert.equal(gate.check(expense(5)).status, "block");
});

// --- 10. pure classifier: deterministic, no hidden clock ----------------------

test("classifySpend is pure: same inputs yield the same decision and audit, using the injected timestamp", () => {
  const opts = { policy: DEFAULT_SPEND_POLICY, approvalCodePresent: false, now: FIXED };
  const a = classifySpend(expense(500), opts);
  const b = classifySpend(expense(500), opts);
  assert.deepEqual(a, b);
  assert.equal(a.audit?.timestamp, FIXED);
});

// --- 11. audit is a frozen copy ----------------------------------------------

test("audit is a frozen snapshot: mutating the returned array cannot corrupt the gate's record", () => {
  const gate = new SpendGate({ clock: fixedClock });
  gate.check(expense(5));
  const snapshot = gate.audit;
  assert.throws(() => {
    (snapshot as SpendGate["audit"][number][]).push({} as never);
  });
  assert.equal(gate.audit.length, 1);
});
