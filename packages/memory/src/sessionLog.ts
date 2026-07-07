/**
 * The session log: `.mainspring/sessions.jsonl`, one JSON object per line, one
 * line per session the loop runs.
 *
 * It is a compact, machine-readable audit trail — `git log` records that a
 * session happened; this records what it accomplished (steps taken, actions
 * dispatched, outcome) in a form a Brain or `mainspring status` can read back
 * cheaply. Append-only and newline-delimited so a crash mid-write can lose at
 * most the last line, never corrupt earlier history.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One session's outcome, as stored on a single line of sessions.jsonl. */
export interface SessionLogEntry {
  /** ISO-8601 timestamp of when the session ended. */
  ts: string;
  /** How many brain.step() reasoning turns the session took. */
  steps: number;
  /** How many Actions the loop dispatched (allowed + applied). */
  actions: number;
  /** Short outcome tag, e.g. "done", "blocked", "error: git lock". */
  outcome: string;
}

/** Absolute path to the session log for a workspace. */
export function sessionLogPath(workspaceDir: string): string {
  return join(workspaceDir, ".mainspring", "sessions.jsonl");
}

/** Appends one session record as a JSON line, creating the file if needed. */
export async function appendSession(
  workspaceDir: string,
  entry: SessionLogEntry,
): Promise<string> {
  const path = sessionLogPath(workspaceDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  return path;
}

/**
 * Reads every session record in file order (oldest first). Malformed or blank
 * lines are skipped rather than throwing, so one bad line can't hide the rest
 * of the history.
 */
export async function readSessions(workspaceDir: string): Promise<SessionLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(sessionLogPath(workspaceDir), "utf8");
  } catch {
    return [];
  }

  const entries: SessionLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as SessionLogEntry);
    } catch {
      // Skip an unparseable line rather than fail the whole read.
    }
  }
  return entries;
}

/**
 * Returns the last `n` session records, oldest first. `n <= 0` yields an empty
 * array; asking for more than exist yields all of them.
 */
export async function lastSessions(workspaceDir: string, n: number): Promise<SessionLogEntry[]> {
  if (n <= 0) return [];
  const all = await readSessions(workspaceDir);
  return all.slice(-n);
}
