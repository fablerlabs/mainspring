import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedger } from "@mainspring/ledger";
import { readSessions } from "@mainspring/memory";
import {
  SimulatedCrash,
  WORK_ITEMS,
  draftPath,
  readTaskProgress,
  runSession1,
  runSession2,
  type TaskProgress,
} from "../src/main.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mainspring-crash-resume-test-"));
}

const RESUMED_FROM_ONE: TaskProgress = { completed: ["draft-intro"], next: "draft-features", done: false };

test("session 1 always ends in a SimulatedCrash, never a clean return", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1), SimulatedCrash);
});

test("session 1's one completed item is fully durable: draft file, ledger row, journal entry, STATE pointer", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));

  const draft = await readFile(draftPath(workspaceDir, { slug: "draft-intro" }), "utf8");
  assert.match(draft, /Draft: product intro/);

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].description, 'Compute for "Draft: product intro"');
  assert.equal(ledger.entries[0].amountUsd, 0.5);
  assert.equal(ledger.balance(), -0.5);

  const progress = await readTaskProgress(workspaceDir);
  assert.deepEqual(progress, RESUMED_FROM_ONE);
});

test("session 1's crash leaves no trace of the next item anywhere on disk", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));

  await assert.rejects(readFile(draftPath(workspaceDir, { slug: "draft-features" }), "utf8"));
  await assert.rejects(readFile(draftPath(workspaceDir, { slug: "draft-pricing" }), "utf8"));
});

test("session 1's crash skips the normal end-of-session bookkeeping", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));

  const sessions = await readSessions(workspaceDir);
  assert.deepEqual(sessions, [], "no session-log record must exist — session 1 never reached appendSession");
});

test("session 2 refuses to proceed if the caller's expectation doesn't match what's actually on disk", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));

  const wrongExpectation: TaskProgress = { completed: [], next: "draft-intro", done: false };
  await assert.rejects(runSession2(workspaceDir, wrongExpectation), /must resume from exactly where/);
});

test("session 2 resumes cold, finishes the task, and never re-charges the already-completed item", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));

  const result = await runSession2(workspaceDir, RESUMED_FROM_ONE);

  assert.deepEqual(result.resumedFrom, RESUMED_FROM_ONE);
  assert.deepEqual(result.itemsCompletedThisSession, ["draft-features", "draft-pricing"]);
  assert.deepEqual(result.finalProgress, {
    completed: WORK_ITEMS.map((w) => w.slug),
    next: null,
    done: true,
  });

  const ledger = await readLedger(workspaceDir);
  assert.equal(ledger.entries.length, 3, "exactly one ledger row per item — the resumed item was never re-charged");
  const expectedTotal = WORK_ITEMS.reduce((sum, w) => sum + w.costUsd, 0);
  assert.equal(result.ledgerBalanceUsd, -Number(expectedTotal.toFixed(2)));
});

test("session 2 writes every remaining draft and marks the task done in STATE.md", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));
  await runSession2(workspaceDir, RESUMED_FROM_ONE);

  for (const item of WORK_ITEMS) {
    const draft = await readFile(draftPath(workspaceDir, item), "utf8");
    assert.match(draft, new RegExp(item.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const progress = await readTaskProgress(workspaceDir);
  assert.equal(progress.done, true);
  assert.equal(progress.next, null);
});

test("session 2 performs the clean end-of-session write session 1 never reached", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));
  await runSession2(workspaceDir, RESUMED_FROM_ONE);

  const sessions = await readSessions(workspaceDir);
  assert.equal(sessions.length, 1, "exactly one session-log record: session 1's crash never wrote one");
  assert.equal(sessions[0].outcome, "done");
});

test("the journal records both sessions in one continuous, day-spanning trail", async () => {
  const workspaceDir = await tempWorkspace();
  await assert.rejects(runSession1(workspaceDir, 1));
  const result = await runSession2(workspaceDir, RESUMED_FROM_ONE);

  const journal = await readFile(result.journalFile, "utf8");
  assert.match(journal, /session 1 start/);
  assert.match(journal, /draft-intro/);
  assert.match(journal, /session 2 start/);
  assert.match(journal, /resumed cold from disk/);
  assert.match(journal, /draft-features/);
  assert.match(journal, /draft-pricing/);
});
