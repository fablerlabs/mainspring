/**
 * The journal: one append-only markdown file per UTC day under `journal/`.
 *
 * A session writes what it did to `journal/YYYY-MM-DD.md`; later sessions read
 * a tail of recent days to remember what just happened. These helpers are the
 * only sanctioned way to touch the journal, so the on-disk format stays
 * consistent across every Brain and every session.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const JOURNAL_DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Absolute path to a given day's journal file. */
export function journalPath(workspaceDir: string, date: string): string {
  return join(workspaceDir, "journal", `${date}.md`);
}

/**
 * Appends `entry` to `journal/<date>.md`, creating the file (with a dated
 * header) on first write and separating entries with a blank line thereafter.
 * `date` is expected as `YYYY-MM-DD`. Returns the path written.
 */
export async function appendJournal(
  workspaceDir: string,
  date: string,
  entry: string,
): Promise<string> {
  const path = journalPath(workspaceDir, date);
  await mkdir(dirname(path), { recursive: true });

  const existing = await readTextIfExists(path);
  const block = ensureTrailingNewline(entry);

  if (!existing) {
    await writeFile(path, `# Journal — ${date}\n\n${block}`, "utf8");
  } else {
    // A blank line between entries: one newline to finish the previous line,
    // one more to make the gap. `appendFile` creates the file if it vanished.
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await appendFile(path, `${separator}${block}`, "utf8");
  }

  return path;
}

/** Keep at most the last `maxBytes` bytes of `text`, starting at a line boundary. */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const sliced = buf.subarray(buf.length - maxBytes).toString("utf8");
  // Drop the (likely partial) first line so the tail starts cleanly.
  const nl = sliced.indexOf("\n");
  return nl >= 0 ? sliced.slice(nl + 1) : sliced;
}

/**
 * Returns the concatenated journal for the most recent `days` day-files,
 * oldest first (so the newest content is at the end), capped at `maxBytes`.
 * When the cap is hit, older day-files are dropped whole; if even the single
 * newest day-file exceeds the cap, only its last `maxBytes` bytes are returned.
 */
export async function tailJournal(
  workspaceDir: string,
  days: number,
  maxBytes: number,
): Promise<string> {
  if (days <= 0 || maxBytes <= 0) return "";

  const dir = join(workspaceDir, "journal");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return "";
  }

  // Date-named files sort lexicographically == chronologically; newest first.
  const dated = names.filter((n) => JOURNAL_DATE_FILE.test(n)).sort().reverse().slice(0, days);

  const chosen: string[] = []; // built oldest-first by prepending
  let bytes = 0;
  for (const name of dated) {
    const text = await readTextIfExists(join(dir, name));
    if (!text) continue;
    // +1 for the newline that will join this file to the block after it.
    const cost = Buffer.byteLength(text, "utf8") + (chosen.length ? 1 : 0);
    if (bytes + cost > maxBytes) {
      if (chosen.length === 0) chosen.unshift(tailBytes(text, maxBytes));
      break;
    }
    chosen.unshift(text);
    bytes += cost;
  }

  return chosen.join("\n");
}
