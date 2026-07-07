import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedger } from "@mainspring/ledger";
import { readSessions } from "@mainspring/memory";
import { runQuickstart } from "../src/main.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mainspring-quickstart-test-"));
}

test("step 1's allowed actions actually ran", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runQuickstart(workspaceDir);

  const step1 = result.steps[0];
  assert.equal(step1.actions.length, 2);
  for (const a of step1.actions) {
    assert.equal(a.verdict, "allow");
    assert.equal(a.applied, true);
  }

  const written = await readFile(join(workspaceDir, "notes/landing-copy.md"), "utf8");
  assert.match(written, /Honest, AI-authored product copy/);

  const notifications = await readFile(join(workspaceDir, "outbox/notifications.log"), "utf8");
  assert.match(notifications, /Quickstart session started/);
});

test("step 2's undisclosed publish attempt is refused by governance, not silently dropped", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runQuickstart(workspaceDir);

  const step2 = result.steps[1];
  assert.equal(step2.actions.length, 1);
  const [blocked] = step2.actions;

  assert.equal(blocked.action.kind, "run");
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.applied, false);
  assert.ok(
    blocked.firedRules.some((r) => r.id === "honesty-disclosure"),
    "governance must name the specific hard rule that fired, not just refuse silently",
  );
});

test("the ledger balance stays correct after an allowed $0 adjustment and a blocked publish", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runQuickstart(workspaceDir);

  assert.equal(result.ledgerBalanceUsd, 0);

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 1, "the blocked run action must never reach the ledger");
  assert.equal(ledger.entries[0].type, "adjustment");
  assert.equal(ledger.balance(), 0);
});

test("the session writes a journal entry per step and one session-log record", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runQuickstart(workspaceDir);

  const journal = await readFile(result.journalFile, "utf8");
  assert.match(journal, /### step 1/);
  assert.match(journal, /### step 2/);
  assert.match(journal, /### step 3/);
  assert.match(journal, /honesty-disclosure/);

  const sessions = await readSessions(workspaceDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].steps, 3);
  assert.equal(sessions[0].outcome, "done");
});

test("the session ends done after exactly 3 steps", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runQuickstart(workspaceDir);
  assert.equal(result.steps.length, 3);
});
