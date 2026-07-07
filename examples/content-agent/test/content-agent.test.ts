import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedger } from "@mainspring/ledger";
import { readSessions } from "@mainspring/memory";
import { runContentAgent } from "../src/main.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mainspring-content-agent-test-"));
}

test("step 1's allowed draft + notify actually ran", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runContentAgent(workspaceDir);

  const step1 = result.steps[0];
  assert.equal(step1.actions.length, 2);
  for (const a of step1.actions) {
    assert.equal(a.verdict, "allow");
    assert.equal(a.applied, true);
  }

  const draft = await readFile(join(workspaceDir, "drafts/post-1.md"), "utf8");
  assert.match(draft, /Why small, honest AI businesses win/);

  const notifications = await readFile(join(workspaceDir, "outbox/notifications.log"), "utf8");
  assert.match(notifications, /Content-agent session started/);
});

test("step 2's undisclosed publish is blocked by the honesty-disclosure rule, by name", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runContentAgent(workspaceDir);

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

test("step 3 files a relay request and a human approves it before the publish is retried", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runContentAgent(workspaceDir);

  const step3 = result.steps[2];
  assert.equal(step3.actions.length, 1);
  const [relayAction] = step3.actions;

  assert.equal(relayAction.action.kind, "relay");
  assert.equal(relayAction.verdict, "allow");
  assert.equal(relayAction.applied, true);

  assert.ok(result.relayRequestId.length > 0, "the relay request must carry a real id from MockRelay");
  assert.equal(result.relayFinalStatus, "done", "the relay request must have been resolved by a human before publish retries");
});

test("step 4's now-disclosed publish is allowed and the disclosed post lands on disk", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runContentAgent(workspaceDir);

  const step4 = result.steps[3];
  assert.equal(step4.actions.length, 1);
  const [published] = step4.actions;

  assert.equal(published.action.kind, "run");
  assert.equal(published.verdict, "allow");
  assert.equal(published.applied, true);

  const post = await readFile(join(workspaceDir, "outbox/published/why-small-honest-ai-businesses-win.md"), "utf8");
  assert.match(post, /This post was written and published by an AI agent/);
});

test("step 5's ledger spend stays within the tiny budget cap", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runContentAgent(workspaceDir);

  assert.equal(result.ledgerBalanceUsd, -4.5);

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 1, "the blocked publish attempt must never reach the ledger");
  assert.equal(ledger.entries[0].type, "expense");
  assert.equal(ledger.entries[0].amountUsd, 4.5);
});

test("the session writes a journal entry per step, mentioning the blocked rule, and one session-log record", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runContentAgent(workspaceDir);

  const journal = await readFile(result.journalFile, "utf8");
  for (let i = 1; i <= 5; i++) {
    assert.match(journal, new RegExp(`### step ${i}`));
  }
  assert.match(journal, /honesty-disclosure/);

  const sessions = await readSessions(workspaceDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].steps, 5);
  assert.equal(sessions[0].outcome, "done");
});

test("the session ends done after exactly 5 steps", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runContentAgent(workspaceDir);
  assert.equal(result.steps.length, 5);
});
