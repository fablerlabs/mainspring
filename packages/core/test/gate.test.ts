import assert from "node:assert/strict";
import { test } from "node:test";
import { gateAction, gateActions } from "../src/gate.js";
import type { Constitution } from "../src/types.js";

const constitution: Constitution = {
  name: "Test Business",
  mission: "test",
  hardRules: ["Legal and honest only."],
  moneyCaps: {
    perSessionUsd: 25,
    notifyAboveUsd: 25,
    approvalAboveUsd: 75,
  },
  maxSessionMs: 40 * 60 * 1000,
};

test("ledger expense within the per-session cap is allowed", () => {
  const decision = gateAction(
    {
      kind: "ledger",
      entry: { date: "2026-01-01T00:00:00.000Z", type: "expense", description: "domain renewal", amountUsd: 12 },
    },
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
  );
  assert.equal(decision.allowed, true);
});

test("ledger expense that exceeds the per-session cap is blocked with a reason", () => {
  const decision = gateAction(
    {
      kind: "ledger",
      entry: { date: "2026-01-01T00:00:00.000Z", type: "expense", description: "ads spend", amountUsd: 100 },
    },
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /exceeding the per-session cap/);
});

test("a sequence of expenses is blocked once their running total crosses the cap", () => {
  const decisions = gateActions(
    [
      { kind: "ledger", entry: { date: "2026-01-01T00:00:00.000Z", type: "expense", description: "a", amountUsd: 15 } },
      { kind: "ledger", entry: { date: "2026-01-01T00:00:00.000Z", type: "expense", description: "b", amountUsd: 15 } },
    ],
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
  );
  assert.equal(decisions[0].allowed, true);
  assert.equal(decisions[1].allowed, false);
  assert.match(decisions[1].reason ?? "", /exceeding the per-session cap/);
});

test("revenue is never capped, only expense", () => {
  const decision = gateAction(
    {
      kind: "ledger",
      entry: { date: "2026-01-01T00:00:00.000Z", type: "revenue", description: "sale", amountUsd: 1000 },
    },
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
  );
  assert.equal(decision.allowed, true);
});

test("writes cannot escape the workspace directory", () => {
  const decision = gateAction(
    { kind: "write", path: "../../etc/passwd", content: "x" },
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /escapes workspace/);
});

test("writes cannot target .env", () => {
  const decision = gateAction(
    { kind: "write", path: ".env", content: "FOO=bar" },
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /forbidden file/);
});

test("write content that looks like a secret is blocked", () => {
  const decision = gateAction(
    { kind: "write", path: "notes.md", content: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz" },
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] },
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /secret-like pattern/);
});

test("run action for an unknown tool is blocked", () => {
  const decision = gateAction(
    { kind: "run", tool: "does-not-exist", args: {} },
    { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [{ name: "http.get", description: "fetch a URL" }] },
  );
  assert.equal(decision.allowed, false);
});

test("done is always allowed", () => {
  const decision = gateAction({ kind: "done" }, { constitution, workspaceDir: "/tmp/workspace", spentSoFarUsd: 0, tools: [] });
  assert.equal(decision.allowed, true);
});
