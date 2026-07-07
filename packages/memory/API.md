# @mainspring/memory API

Durable, deterministic memory utilities for the amnesiac session loop:
`STATE.md` compaction, the per-day journal, and the append-only session log.
Zero runtime dependencies; no LLM calls. Every function here is a pure
filesystem/string operation — given the same inputs (and the same files on
disk) it produces the same output every time.

## Exports

### `state.ts` — STATE.md compaction

`STATE.md` has a stable head (title + `## Status` / `## Next up` /
`## Open questions` sections a Brain rewrites in place) followed by an
append-only session-log section that grows every session. `compactState`
enforces a line budget on that file without any LLM call: it keeps the head
verbatim and keeps only the most recent session-log entries that still fit,
dropping the oldest first. It is deterministic — same input, same output,
always.

```ts
export interface CompactStateOptions {
  sessionLogHeading?: RegExp; // default: /^##\s+session log\b/i
  entryHeading?: RegExp;      // default: /^###\s+/
}

export interface CompactStateResult {
  content: string; // the compacted STATE.md content
  dropped: number;  // how many whole session-log entries were removed (always the oldest)
}

function compactState(
  content: string,
  maxLines: number,
  options: CompactStateOptions = {},
): CompactStateResult
```

`sessionLogHeading` identifies the heading line that begins the session-log
section; everything from the top of the file up to and including that
heading is the "head" and is never dropped. `entryHeading` identifies the
marker that begins one entry within that section (defaulting to a `### `
sub-heading); entries are assumed to be in file order, oldest first.

Algorithm, read directly off `state.ts`:

1. Split `content` into lines (remembering whether it ended with a trailing
   newline, so that's preserved on output).
2. Find the first line matching `sessionLogHeading`. If none is found, return
   `{ content, dropped: 0 }` unchanged — there is nothing safe to compact.
3. Everything up to and including that heading is the `head`. Everything
   after it is split into a `preamble` (lines before the first entry, e.g. a
   blank spacer) and a list of `entries` (each is the run of lines from one
   `entryHeading` match up to the next).
4. Walk the entries from newest to oldest, accumulating a running line count
   that starts at `head.length + preamble.length`. Keep adding an entry to
   the kept set as long as `used + entry.length <= maxLines`. As soon as one
   entry doesn't fit, stop — that entry and every older one are dropped, so
   the kept entries always form a contiguous "most recent" suffix. (The head
   is preserved verbatim even if it alone exceeds `maxLines`; this function
   only ever shrinks the log.)
5. If nothing was dropped, return the original `content` unchanged with
   `dropped: 0`. Otherwise rebuild `head + preamble + kept entries`, restore
   the trailing newline if the input had one, and return it with the count
   of dropped entries.

```ts
import { compactState } from "@mainspring/memory";

const { content, dropped } = compactState(stateMd, 200);
// content: STATE.md with the oldest session-log entries trimmed to fit
// dropped: how many whole entries were removed (0 if nothing needed trimming)
```

### `journal.ts` — the per-day journal

One append-only markdown file per UTC day under `journal/` inside the
workspace directory: `journal/YYYY-MM-DD.md`. A session appends what it did
to today's file; later sessions read a tail of recent days to recall what
just happened.

```ts
function journalPath(workspaceDir: string, date: string): string
```
Absolute path to a given day's journal file: `join(workspaceDir, "journal", \`${date}.md\`)`.

```ts
function appendJournal(
  workspaceDir: string,
  date: string,
  entry: string,
): Promise<string>
```
Appends `entry` to `journal/<date>.md` (`date` is `YYYY-MM-DD`), creating the
`journal/` directory and the file as needed. On first write the file is
created as `# Journal — <date>\n\n<entry>\n` (a dated header followed by the
entry, trailing newline ensured). On subsequent writes the same day, a blank
line separates the new entry from what's already there (one newline to close
the previous line's block, one more for the gap), then the entry text (again
newline-terminated) is appended. Returns the path written.

```ts
function tailJournal(
  workspaceDir: string,
  days: number,
  maxBytes: number,
): Promise<string>
```
Returns the concatenated journal text for the most recent `days` day-files
under `journal/`, oldest first (so the newest day's content ends up last),
capped at `maxBytes` total bytes. Day-files are matched by the
`YYYY-MM-DD.md` filename pattern and sorted lexicographically (== chronologically), newest
first, then the most recent `days` of them are considered. Whole day-files
are dropped (oldest first) once the byte budget would be exceeded; if even
the single newest included day-file alone exceeds `maxBytes`, only its last
`maxBytes` bytes are returned (sliced at a line boundary, dropping a likely
partial first line). Returns `""` if `days <= 0`, `maxBytes <= 0`, or the
`journal/` directory doesn't exist yet.

```ts
import { appendJournal, tailJournal, journalPath } from "@mainspring/memory";

await appendJournal("./my-business", "2026-07-07", "- Shipped v1 landing page.");
// -> writes ./my-business/journal/2026-07-07.md

const recent = await tailJournal("./my-business", 2, 10_000);
// recent: text of the 2 most recent journal/*.md files, oldest first,
// truncated to at most 10,000 bytes total

journalPath("./my-business", "2026-07-07");
// -> "./my-business/journal/2026-07-07.md"
```

### `sessionLog.ts` — the append-only session log

`.mainspring/sessions.jsonl` inside the workspace directory: one JSON object
per line, one line per session the loop runs. It's a compact,
machine-readable audit trail of what each session accomplished (as opposed
to `git log`, which just records that a session happened). Newline-delimited
JSON so a crash mid-write can lose at most the last line, never corrupt
earlier history.

```ts
export interface SessionLogEntry {
  ts: string;       // ISO-8601 timestamp of when the session ended
  steps: number;    // how many brain.step() reasoning turns the session took
  actions: number;  // how many Actions the loop dispatched (allowed + applied)
  outcome: string;  // short outcome tag, e.g. "done", "blocked", "error: git lock"
}

function sessionLogPath(workspaceDir: string): string
```
Absolute path to the session log for a workspace: `join(workspaceDir, ".mainspring", "sessions.jsonl")`.

```ts
function appendSession(
  workspaceDir: string,
  entry: SessionLogEntry,
): Promise<string>
```
Appends one session record as a single JSON line (`JSON.stringify(entry) + "\n"`),
creating `.mainspring/` and the file as needed. Returns the path written.

```ts
function readSessions(workspaceDir: string): Promise<SessionLogEntry[]>
```
Reads every session record in file order (oldest first). Blank lines are
skipped, and any line that fails `JSON.parse` is skipped rather than
throwing — so one malformed line can't hide the rest of the history. Returns
`[]` if the log file doesn't exist.

```ts
function lastSessions(workspaceDir: string, n: number): Promise<SessionLogEntry[]>
```
Returns the last `n` session records, oldest first. `n <= 0` yields `[]`;
asking for more than exist yields all of them. Implemented as
`(await readSessions(workspaceDir)).slice(-n)`.

```ts
import { appendSession, readSessions, lastSessions, sessionLogPath } from "@mainspring/memory";

await appendSession("./my-business", {
  ts: new Date().toISOString(),
  steps: 3,
  actions: 2,
  outcome: "done",
});

const all = await readSessions("./my-business");     // every session, oldest first
const recent = await lastSessions("./my-business", 5); // last 5 sessions, oldest first

sessionLogPath("./my-business");
// -> "./my-business/.mainspring/sessions.jsonl"
```
