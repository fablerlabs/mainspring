import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compactState } from "../src/state.js";
import { appendJournal, tailJournal, journalPath } from "../src/journal.js";
import { appendSession, readSessions, lastSessions, type SessionLogEntry } from "../src/sessionLog.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mainspring-memory-"));
}

const HEAD = [
  "# STATE — Test Business",
  "",
  "## Status",
  "Running.",
  "",
  "## Session log",
  "",
].join("\n");

function stateWith(entryCount: number): string {
  const entries: string[] = [];
  for (let i = 1; i <= entryCount; i++) {
    entries.push(`### session ${i}`, `did thing ${i}`);
  }
  return `${HEAD}${entries.join("\n")}\n`;
}

// --- compactState -----------------------------------------------------------

test("compactState keeps the head and the most recent entries, dropping oldest first", () => {
  const content = stateWith(5); // head = 7 lines, each entry = 2 lines
  // Budget for head (7) + 2 most-recent entries (4) = 11 lines.
  const result = compactState(content, 11);

  assert.equal(result.dropped, 3);
  assert.ok(result.content.startsWith(HEAD), "head must be preserved verbatim");
  assert.match(result.content, /### session 4/);
  assert.match(result.content, /### session 5/);
  assert.doesNotMatch(result.content, /### session 1\b/);
  assert.doesNotMatch(result.content, /### session 3\b/);
});

test("compactState never drops the head even when it alone exceeds the budget", () => {
  const content = stateWith(3);
  const result = compactState(content, 2); // far below head size

  assert.ok(result.content.startsWith("# STATE — Test Business"));
  assert.match(result.content, /## Session log/);
  assert.equal(result.dropped, 3, "all entries dropped, head intact");
  assert.doesNotMatch(result.content, /### session/);
});

test("compactState leaves content untouched when nothing needs dropping", () => {
  const content = stateWith(2);
  const result = compactState(content, 1000);
  assert.equal(result.dropped, 0);
  assert.equal(result.content, content);
});

test("compactState returns content unchanged when there is no session-log heading", () => {
  const content = "# STATE\n\n## Status\nok\n";
  const result = compactState(content, 1);
  assert.equal(result.dropped, 0);
  assert.equal(result.content, content);
});

test("compactState preserves a trailing newline (or its absence)", () => {
  const withNl = stateWith(4);
  assert.ok(compactState(withNl, 9).content.endsWith("\n"));

  const withoutNl = withNl.slice(0, -1);
  assert.ok(!compactState(withoutNl, 9).content.endsWith("\n"));
});

// --- journal ----------------------------------------------------------------

test("appendJournal creates a dated file with a header on first write", async () => {
  const ws = await tempWorkspace();
  const path = await appendJournal(ws, "2026-07-07", "first note");
  assert.equal(path, journalPath(ws, "2026-07-07"));

  const text = await readFile(path, "utf8");
  assert.match(text, /^# Journal — 2026-07-07\n/);
  assert.match(text, /first note\n$/);
});

test("appendJournal appends subsequent entries with a blank-line separator", async () => {
  const ws = await tempWorkspace();
  await appendJournal(ws, "2026-07-07", "first note");
  await appendJournal(ws, "2026-07-07", "second note");

  const text = await readFile(journalPath(ws, "2026-07-07"), "utf8");
  assert.match(text, /first note/);
  assert.match(text, /second note/);
  assert.match(text, /first note\n\nsecond note\n$/);
  // Exactly one header despite two appends.
  assert.equal(text.match(/# Journal —/g)?.length, 1);
});

test("tailJournal concatenates recent days oldest-first, respecting the day count", async () => {
  const ws = await tempWorkspace();
  await appendJournal(ws, "2026-07-05", "day five");
  await appendJournal(ws, "2026-07-06", "day six");
  await appendJournal(ws, "2026-07-07", "day seven");

  const tail = await tailJournal(ws, 2, 10_000);
  assert.doesNotMatch(tail, /day five/, "only the 2 most recent days included");
  assert.match(tail, /day six/);
  assert.match(tail, /day seven/);
  assert.ok(tail.indexOf("day six") < tail.indexOf("day seven"), "oldest first");
});

test("tailJournal drops whole older day-files to stay under maxBytes", async () => {
  const ws = await tempWorkspace();
  await appendJournal(ws, "2026-07-06", "OLDER");
  await appendJournal(ws, "2026-07-07", "NEWER");

  const newerBytes = Buffer.byteLength(await readFile(journalPath(ws, "2026-07-07"), "utf8"), "utf8");
  const tail = await tailJournal(ws, 5, newerBytes);
  assert.match(tail, /NEWER/);
  assert.doesNotMatch(tail, /OLDER/);
});

test("tailJournal returns empty string when there is no journal directory", async () => {
  const ws = await tempWorkspace();
  assert.equal(await tailJournal(ws, 5, 10_000), "");
});

// --- sessionLog -------------------------------------------------------------

function entry(i: number): SessionLogEntry {
  return { ts: `2026-07-07T00:0${i}:00.000Z`, steps: i, actions: i * 2, outcome: "done" };
}

test("appendSession + readSessions round-trips in file order", async () => {
  const ws = await tempWorkspace();
  await appendSession(ws, entry(1));
  await appendSession(ws, entry(2));

  const all = await readSessions(ws);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], entry(1));
  assert.deepEqual(all[1], entry(2));
});

test("lastSessions returns the last n entries, oldest first", async () => {
  const ws = await tempWorkspace();
  for (let i = 1; i <= 4; i++) await appendSession(ws, entry(i));

  const last2 = await lastSessions(ws, 2);
  assert.deepEqual(last2.map((e) => e.steps), [3, 4]);

  assert.deepEqual(await lastSessions(ws, 0), []);
  assert.equal((await lastSessions(ws, 99)).length, 4, "asking for more than exist yields all");
});

test("readSessions skips malformed lines instead of throwing", async () => {
  const ws = await tempWorkspace();
  await appendSession(ws, entry(1));
  const path = join(ws, ".mainspring", "sessions.jsonl");
  await mkdir(join(ws, ".mainspring"), { recursive: true });
  await writeFile(path, `${JSON.stringify(entry(1))}\nnot json\n\n${JSON.stringify(entry(2))}\n`, "utf8");

  const all = await readSessions(ws);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.steps), [1, 2]);
});

test("readSessions returns empty when the log does not exist", async () => {
  const ws = await tempWorkspace();
  assert.deepEqual(await readSessions(ws), []);
});
