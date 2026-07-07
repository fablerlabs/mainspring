import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedger, checkSpend, DEFAULT_SPEND_POLICY } from "@mainspring/ledger";
import { readSessions } from "@mainspring/memory";
import { runFullStackSession, CONSTITUTION_MD } from "../src/main.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mainspring-full-stack-test-"));
}

// --- core + brains + governance -------------------------------------------

test("step 1's allowed actions actually ran (core.applyAction + brains.MockBrain + governance.evaluate)", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  const step1 = result.steps[0];
  assert.equal(step1.actions.length, 2);
  for (const a of step1.actions) {
    assert.equal(a.verdict, "allow");
    assert.equal(a.applied, true);
  }

  const written = await readFile(join(workspaceDir, "notes/product.md"), "utf8");
  assert.match(written, /Honest, AI-authored product copy/);

  const notifications = await readFile(join(workspaceDir, "outbox/notifications.log"), "utf8");
  assert.match(notifications, /Full-stack session started/);
});

test("governance BLOCKs an over-cap expense by name, and the ledger never sees it", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  const step3 = result.steps[2];
  assert.equal(step3.actions.length, 1);
  const [blocked] = step3.actions;

  assert.equal(blocked.action.kind, "ledger");
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.applied, false);
  assert.ok(
    blocked.firedRules.some((r) => r.id === "spend-caps"),
    "governance must name the specific hard rule that fired, not just refuse silently",
  );
});

test("governance BLOCKs a write carrying a leaked secret by name, and it never touches disk", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  const step4 = result.steps[3];
  assert.equal(step4.actions.length, 1);
  const [blocked] = step4.actions;

  assert.equal(blocked.action.kind, "write");
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.applied, false);
  assert.ok(
    blocked.firedRules.some((r) => r.id === "no-secrets"),
    "governance must name the specific hard rule that fired",
  );

  await assert.rejects(() => readFile(join(workspaceDir, "notes/leaked.md"), "utf8"), /ENOENT/);
});

test("assemble() re-reads exactly what the loop just wrote: compacted STATE.md at step 1, decremented budget after the step-2 expense", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  // Step 1: assemble() must have read back the exact compacted STATE.md this run produced.
  assert.equal(result.assembledStateAtStep1, result.state.compactedContent);

  // budgetRemainingUsdByStep[i] is what assemble() computed BEFORE step i+1's actions ran.
  assert.equal(result.budgetRemainingUsdByStep.length, 6);
  assert.equal(result.budgetRemainingUsdByStep[0], 50, "nothing spent yet going into step 1");
  assert.equal(result.budgetRemainingUsdByStep[1], 50, "step 2's $15 expense hasn't been dispatched yet going into step 2");
  assert.equal(result.budgetRemainingUsdByStep[2], 35, "going into step 3, core's assemble() must see the $15 expense step 2 just wrote to LEDGER.csv");
  // The blocked $999 (step 3) and blocked write (step 4) never touch the ledger, so budget stays at 35 through step 5.
  assert.equal(result.budgetRemainingUsdByStep[3], 35);
  assert.equal(result.budgetRemainingUsdByStep[4], 35);
});

// --- ledger -----------------------------------------------------------------

test("ledger balance is exactly right after the allowed expense, blocked expense, and revenue", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  // -$15 (allowed hosting expense) + $0 (blocked $999 never applied) + $29 (revenue) = $14.00
  assert.equal(result.ledgerBalanceUsd, 14);

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 2, "the blocked $999 expense must never reach the ledger");
  assert.equal(ledger.entries[0].type, "expense");
  assert.equal(ledger.entries[0].amountUsd, 15);
  assert.equal(ledger.entries[1].type, "revenue");
  assert.equal(ledger.entries[1].amountUsd, 29);
  assert.equal(ledger.balance(), 14);
});

test("ledger's own spend-cap classifier agrees the blocked amount needed approval, and the allowed one didn't", async () => {
  assert.equal(checkSpend(999, DEFAULT_SPEND_POLICY), "needs-approval");
  assert.equal(checkSpend(15, DEFAULT_SPEND_POLICY), "proceed");
});

// --- memory: STATE.md + journal + session log -------------------------------

test("memory compacts an oversized STATE.md, and the compacted head survives the whole session untouched", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  assert.equal(result.state.droppedEntries, 2, "the two oldest session-log entries should be dropped to fit the 40-line budget");
  assert.match(result.state.compactedContent, /# Full-Stack Test Business/);
  assert.match(result.state.compactedContent, /## Status/);
  assert.match(result.state.compactedContent, /### session 8/, "the newest entry must survive compaction");
  assert.doesNotMatch(result.state.compactedContent, /### session 1\b/, "the oldest entry must be dropped");

  // What's on disk at session end is exactly what compactState produced —
  // nothing in the loop silently rewrote STATE.md.
  const onDisk = await readFile(join(workspaceDir, "STATE.md"), "utf8");
  assert.equal(onDisk, result.state.compactedContent);
});

test("the session writes a journal entry per step and one session-log record, naming every blocked rule", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  const journal = await readFile(result.journalFile, "utf8");
  for (let step = 1; step <= 6; step++) {
    assert.match(journal, new RegExp(`### step ${step}\\b`));
  }
  assert.match(journal, /spend-caps/);
  assert.match(journal, /no-secrets/);

  const sessions = await readSessions(workspaceDir);
  assert.equal(sessions.length, 1, "exactly one session-log record for this one session — the git-style audit trail");
  assert.equal(sessions[0].steps, 6);
  assert.equal(sessions[0].outcome, "done");
  const totalActions = result.steps.reduce((sum, s) => sum + s.actions.length, 0);
  assert.equal(sessions[0].actions, totalActions, "the session log's action count must match exactly what the loop dispatched");
});

// --- scrub --------------------------------------------------------------------

test("scrub finds the leaked AWS key, redacts it, and the redacted draft is clean", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  assert.equal(result.scrub.findingsBeforeRedaction.length, 1);
  assert.equal(result.scrub.findingsBeforeRedaction[0].pattern, "aws access key id");
  assert.doesNotMatch(result.scrub.findingsBeforeRedaction[0].excerpt, /IOSFODNN7EXAMPLE/, "scrub must never echo the full secret, even in a finding excerpt");

  assert.equal(result.scrub.findingsAfterRedaction.length, 0, "the redacted draft must be clean");
  assert.match(result.scrub.redactedContent, /<OLD_AWS_KEY>/);
  assert.doesNotMatch(result.scrub.redactedContent, /AKIA/);

  // The redacted (safe) draft actually made it to disk, since it cleared governance too.
  const published = await readFile(join(workspaceDir, "outbox/launch-draft.md"), "utf8");
  assert.equal(published, result.scrub.redactedContent);
});

// --- relay ----------------------------------------------------------------

test("the loop files a relay request for a human-only blocker and resolves it via MockRelay", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  const step5 = result.steps[4];
  assert.equal(step5.actions.length, 1);
  assert.equal(step5.actions[0].action.kind, "relay");
  assert.equal(step5.actions[0].verdict, "allow");
  assert.equal(step5.actions[0].applied, true);

  assert.equal(result.relay.requestId, "rl-product-hunt");
  assert.match(result.relay.mockId, /^mock/);
  assert.equal(result.relay.resolvedStatus, "done");
  assert.match(result.relay.resolvedResult ?? "", /owner created the account/);
});

// --- end to end ---------------------------------------------------------------

test("the session ends done after exactly 6 steps, with 2 of 7 actions blocked by name", async () => {
  const workspaceDir = await tempWorkspace();
  const result = await runFullStackSession(workspaceDir);

  assert.equal(result.steps.length, 6);

  const allActions = result.steps.flatMap((s) => s.actions);
  const blocked = allActions.filter((a) => a.verdict !== "allow");
  assert.equal(blocked.length, 2);
  assert.deepEqual(
    blocked.map((a) => a.firedRules.map((r) => r.id)).flat().sort(),
    ["no-secrets", "spend-caps"],
  );
});

test("the constitution's hard rules are all named in CONSTITUTION_MD", () => {
  assert.match(CONSTITUTION_MD, /rule:honesty-disclosure/);
  assert.match(CONSTITUTION_MD, /rule:no-secrets/);
  assert.match(CONSTITUTION_MD, /rule:spend-caps/);
  assert.match(CONSTITUTION_MD, /rule:external-allowlist/);
});
