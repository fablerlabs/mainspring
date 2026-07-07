/**
 * Crash-and-resume: the amnesia demo.
 *
 * Mainspring's core bet is that a session can be killed at any moment — no
 * graceful shutdown, no chance to "save your work" — and the next session
 * still knows exactly what happened, because nothing that matters ever lived
 * only in RAM. This example proves that bet with real assertions, not prose:
 *
 *   Session 1 works through a 3-item task one item at a time. Each item's
 *   completion is fully durable (a draft file, a `LEDGER.csv` expense row, a
 *   journal entry, and a `STATE.md` progress pointer) before the next item
 *   starts. After finishing exactly one item, session 1 throws — simulating
 *   the supervisor killing the process — *before* it reaches the normal
 *   end-of-session bookkeeping (`appendSession`). Nothing "wraps up".
 *
 *   Session 2 is a brand-new process: no shared memory, no module-level
 *   state, no conversation history. It reads STATE.md/LEDGER.csv/journal
 *   cold, asserts that what it finds matches exactly what session 1 should
 *   have finished (not more, not less), and — critically — checks the
 *   ledger before redoing any work, so a resumed session can never
 *   double-charge an item it already paid for. It then finishes the
 *   remaining items and performs the clean session-end write session 1
 *   never got to make.
 *
 * Only `@mainspring/ledger` and `@mainspring/memory` are used here — this is
 * deliberately not a `Brain`/governance/relay wiring demo like
 * `examples/quickstart`; it isolates the one thing this example is about:
 * durable, amnesia-proof state across a hard process boundary.
 *
 * Deterministic: every timestamp is a fixed constant, never `Date.now()` or
 * `new Date()`, so two runs produce byte-identical LEDGER.csv/journal output.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { appendLedger, readLedger } from "@mainspring/ledger";
import { appendJournal, appendSession, journalPath, sessionLogPath } from "@mainspring/memory";

/** Fixed, deterministic timestamps — this example never touches the wall clock. */
const DAY = "2026-01-01";
const SESSION_1_TS = "2026-01-01T09:00:00.000Z";
const SESSION_2_TS = "2026-01-01T14:00:00.000Z";

/** One item of the 3-item work order this example's task works through, in order. */
export interface WorkItem {
  slug: string;
  title: string;
  costUsd: number;
}

export const WORK_ITEMS: readonly WorkItem[] = [
  { slug: "draft-intro", title: "Draft: product intro", costUsd: 0.5 },
  { slug: "draft-features", title: "Draft: feature overview", costUsd: 0.75 },
  { slug: "draft-pricing", title: "Draft: pricing page copy", costUsd: 0.4 },
];

/** The machine-readable progress block this example keeps inside STATE.md. */
export interface TaskProgress {
  completed: string[];
  next: string | null;
  done: boolean;
}

function initialProgress(): TaskProgress {
  return { completed: [], next: WORK_ITEMS[0].slug, done: false };
}

function statePath(workspaceDir: string): string {
  return join(workspaceDir, "STATE.md");
}

export function draftPath(workspaceDir: string, item: Pick<WorkItem, "slug">): string {
  return join(workspaceDir, "drafts", `${item.slug}.md`);
}

const PROGRESS_HEADING = "## Task progress (machine-readable)";
const PROGRESS_BLOCK = /```json\n([\s\S]*?)\n```/;

/**
 * Renders the full STATE.md content: a human-readable head plus a fenced
 * JSON block a session can parse without guessing at markdown structure.
 * Overwriting the whole file on every write keeps the format trivial to
 * reason about — this example has nothing else worth keeping in STATE.md.
 */
function renderState(progress: TaskProgress): string {
  const status = progress.done
    ? `All ${WORK_ITEMS.length} items done. Task complete.`
    : progress.completed.length === 0
      ? `Not started. First item up: ${progress.next}.`
      : `${progress.completed.length}/${WORK_ITEMS.length} items done. Next up: ${progress.next}.`;

  return `# STATE — Crash-Resume Example

This file is the durable memory of the task between sessions. A session is
amnesiac: everything needed to resume must be written here (or in
\`journal/\`, \`LEDGER.csv\`, \`drafts/\`) before the process can be trusted to
have "remembered" anything — including a process that never gets to exit
cleanly.

## Status

${status}

${PROGRESS_HEADING}

\`\`\`json
${JSON.stringify(progress, null, 2)}
\`\`\`
`;
}

/** Reads STATE.md's progress block. An absent or malformed file reads as "nothing done yet". */
export async function readTaskProgress(workspaceDir: string): Promise<TaskProgress> {
  let raw: string;
  try {
    raw = await readFile(statePath(workspaceDir), "utf8");
  } catch {
    return initialProgress();
  }
  const match = raw.match(PROGRESS_BLOCK);
  if (!match) return initialProgress();
  return JSON.parse(match[1]) as TaskProgress;
}

async function writeTaskProgress(workspaceDir: string, progress: TaskProgress): Promise<void> {
  await writeFile(statePath(workspaceDir), renderState(progress), "utf8");
}

/**
 * Fully and durably completes one item: draft file, ledger expense, journal
 * entry, then the STATE.md progress pointer — in that order, each write
 * awaited before the next starts. By the time this resolves, the item is
 * "real" from every one of the three independent sources of truth a future
 * session reads; there is no window where only an in-memory variable knows
 * this item happened.
 */
async function completeItem(
  workspaceDir: string,
  item: WorkItem,
  progress: TaskProgress,
  ts: string,
): Promise<TaskProgress> {
  const path = draftPath(workspaceDir, item);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `# ${item.title}\n\nDrafted by the crash-resume example task.\n`, "utf8");

  await appendLedger(workspaceDir, {
    date: ts,
    type: "expense",
    description: `Compute for "${item.title}"`,
    amountUsd: item.costUsd,
  });

  await appendJournal(
    workspaceDir,
    DAY,
    `### ${item.slug}\n- completed "${item.title}" ($${item.costUsd.toFixed(2)})`,
  );

  const completed = [...progress.completed, item.slug];
  const remaining = WORK_ITEMS.filter((w) => !completed.includes(w.slug));
  const next: TaskProgress = {
    completed,
    next: remaining[0]?.slug ?? null,
    done: remaining.length === 0,
  };
  await writeTaskProgress(workspaceDir, next);
  return next;
}

/** Thrown by `runSession1` to simulate the supervisor killing the process mid-task. */
export class SimulatedCrash extends Error {
  constructor(afterSlug: string) {
    super(
      `SIMULATED CRASH: process killed right after finishing "${afterSlug}" — ` +
        "nothing about the next item exists anywhere on disk yet.",
    );
    this.name = "SimulatedCrash";
  }
}

/**
 * Session 1: a fresh process working through the task from a cold, empty
 * workspace. Completes exactly `crashAfterCount` items — each one fully
 * durable before the next starts — then throws `SimulatedCrash` instead of
 * continuing. It never reaches `appendSession`, so the session log stays
 * empty: the "this session ended" bookkeeping a graceful shutdown would do
 * simply never runs. Always throws; there is no clean-return path, by
 * design — this function models a session that gets killed, not one that
 * finishes.
 */
export async function runSession1(workspaceDir: string, crashAfterCount: number): Promise<never> {
  assert.ok(
    crashAfterCount > 0 && crashAfterCount < WORK_ITEMS.length,
    "this example only makes sense if session 1 crashes strictly between the first and last item",
  );

  await writeTaskProgress(workspaceDir, initialProgress());
  await appendJournal(workspaceDir, DAY, "### session 1 start\n- booting from an empty workspace; nothing done yet");

  let progress = initialProgress();
  for (let i = 0; i < crashAfterCount; i++) {
    progress = await completeItem(workspaceDir, WORK_ITEMS[i], progress, SESSION_1_TS);
  }

  throw new SimulatedCrash(WORK_ITEMS[crashAfterCount - 1].slug);
}

export interface Session2Result {
  resumedFrom: TaskProgress;
  finalProgress: TaskProgress;
  itemsCompletedThisSession: string[];
  ledgerBalanceUsd: number;
  journalFile: string;
  sessionLogFile: string;
}

/**
 * Session 2: a brand-new process — no globals, no shared memory, no
 * conversation history survive a real crash, so neither does anything here.
 * It reads STATE.md's progress block cold, asserts it matches exactly what
 * the caller expects session 1 to have finished (proving the resume point
 * is exact, not approximate), cross-checks the ledger has one row per
 * completed item (so finishing the task can never re-charge a completed
 * item), then completes whatever remains and performs the clean
 * end-of-session write session 1 never reached.
 */
export async function runSession2(
  workspaceDir: string,
  expectResumedFrom: TaskProgress,
): Promise<Session2Result> {
  const resumedFrom = await readTaskProgress(workspaceDir);
  assert.deepEqual(
    resumedFrom,
    expectResumedFrom,
    "session 2 must resume from exactly where session 1's disk state says — nothing more, nothing less",
  );

  const ledgerBeforeResume = await readLedger(workspaceDir);
  assert.equal(
    ledgerBeforeResume.entries.length,
    resumedFrom.completed.length,
    "the ledger must already carry exactly one row per completed item, so resuming never re-charges one",
  );

  const remaining = WORK_ITEMS.filter((w) => !resumedFrom.completed.includes(w.slug));
  for (const item of remaining) {
    await assert.rejects(
      readFile(draftPath(workspaceDir, item), "utf8"),
      `"${item.slug}"'s draft must not exist yet — session 1 crashed before it ever started`,
    );
  }

  await appendJournal(
    workspaceDir,
    DAY,
    [
      "### session 2 start",
      `- resumed cold from disk: ${resumedFrom.completed.length}/${WORK_ITEMS.length} items done; next up: ${resumedFrom.next}`,
    ].join("\n"),
  );

  let progress = resumedFrom;
  for (const item of remaining) {
    progress = await completeItem(workspaceDir, item, progress, SESSION_2_TS);
  }
  assert.equal(progress.done, true, "every remaining item must be completed before the task can be marked done");

  await appendSession(workspaceDir, {
    ts: SESSION_2_TS,
    steps: remaining.length,
    actions: remaining.length * 3,
    outcome: "done",
  });

  const ledger = await readLedger(workspaceDir);
  return {
    resumedFrom,
    finalProgress: progress,
    itemsCompletedThisSession: remaining.map((w) => w.slug),
    ledgerBalanceUsd: ledger.balance(),
    journalFile: journalPath(workspaceDir, DAY),
    sessionLogFile: sessionLogPath(workspaceDir),
  };
}

async function main(): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-crash-resume-"));
  console.log(`Mainspring crash-resume — workspace: ${workspaceDir}\n`);

  console.log("Session 1: working through the task from an empty workspace...");
  let crash: unknown;
  try {
    await runSession1(workspaceDir, 1);
  } catch (err) {
    crash = err;
  }
  assert.ok(crash instanceof SimulatedCrash, "session 1 must end in a simulated crash, never a clean return");
  console.log(`  -> ${(crash as Error).message}`);
  console.log("  -> process exits here. No cleanup ran: no closing journal note, no session-log entry.\n");

  console.log("Session 2: a brand-new process, booting cold from disk only...");
  const expectResumedFrom: TaskProgress = { completed: ["draft-intro"], next: "draft-features", done: false };
  const result = await runSession2(workspaceDir, expectResumedFrom);
  console.log(`  -> resumed at exactly item "${result.resumedFrom.next}" (verified against STATE.md and the ledger)`);
  console.log(`  -> completed the remaining items: ${result.itemsCompletedThisSession.join(", ")}`);
  console.log(`  -> final progress: ${result.finalProgress.completed.join(", ")}; done=${result.finalProgress.done}`);
  console.log(`  -> ledger balance: $${result.ledgerBalanceUsd.toFixed(2)}`);
  console.log(`  -> journal:     ${result.journalFile}`);
  console.log(`  -> session log: ${result.sessionLogFile}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
