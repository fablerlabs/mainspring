// Step (b): a memory file the agent maintains across cold runs.
// Run this script twice — the second run sees what the first one wrote.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { appendJournal, tailJournal } from "@mainspring/memory";
import { appendSession, readSessions } from "@mainspring/memory";
import { compactState } from "@mainspring/memory";

const ws = join(process.cwd(), "_workspace");
await mkdir(ws, { recursive: true });
const statePath = join(ws, "STATE.md");
const today = "2026-07-07"; // fixed for a reproducible demo

// 1. ASSEMBLE — recover everything from disk. A cold session has nothing else.
let state = await readFile(statePath, "utf8").catch(() => null);
const priorSessions = await readSessions(ws);
const n = priorSessions.length + 1;

if (state === null) {
  console.log("First run: no memory on disk yet. Booting from the constitution's mission.");
  state = "# STATE — Nightshift Notes\n\n## Status\nSession 0 — nothing shipped yet.\n\n## Session log\n";
} else {
  console.log(`Run ${n}: recovered STATE.md written by a previous session:`);
  console.log("  " + state.split("\n").find((l) => l.startsWith("Session")));
  const yesterday = await tailJournal(ws, 1, 4096);
  console.log("  last journal note: " + (yesterday.trim().split("\n").pop() ?? "(none)"));
}

// 2. WORK — do a slice, then WRITE what tomorrow's amnesiac session must know.
await appendJournal(ws, today, `### session ${n}\n- Shipped: drafted product page section ${n}.`);
state = state.replace(/## Status\n[^\n]*/, `## Status\nSession ${n} — product page ${n} sections drafted.`)
  + `\n### session ${n}\nDrafted section ${n}; balance unchanged.\n`;

// 3. COMPACT — the mechanical backstop so STATE.md can't grow without bound.
const { content, dropped } = compactState(state, 12);
await writeFile(statePath, content, "utf8");

// 4. LOG — one immutable line per session, the audit trail's heartbeat.
await appendSession(ws, { ts: `${today}T0${n}:00:00Z`, steps: 1, actions: 2, outcome: "done" });

console.log(`Wrote session ${n} to memory (compaction dropped ${dropped} old log entr${dropped === 1 ? "y" : "ies"}).`);
