/**
 * STATE.md compaction.
 *
 * STATE.md is the durable, human- and brain-readable memory of a business. It
 * has a stable head (title + `## Status` / `## Next up` / `## Open questions`
 * sections the brain rewrites in place) followed by an append-only session log
 * that grows every session. Left unchecked that log crowds out a brain's
 * context budget.
 *
 * `compactState` enforces a line budget WITHOUT any LLM call: it keeps the head
 * verbatim and keeps only the most recent session-log entries that still fit,
 * dropping the oldest first. The Brain is still free to rewrite STATE.md
 * semantically; this is the mechanical backstop that guarantees the file can't
 * grow without bound. It is deterministic — same input, same output, always.
 */

export interface CompactStateOptions {
  /**
   * Heading that begins the session-log section. Everything from the top of the
   * file up to and including this heading is "head" and is never dropped.
   * Default: a `## Session log` heading (case-insensitive).
   */
  sessionLogHeading?: RegExp;
  /**
   * Marker that begins one entry within the session-log section. Entries are in
   * file order (oldest first); compaction keeps a contiguous suffix of them.
   * Default: a `### ` sub-heading.
   */
  entryHeading?: RegExp;
}

export interface CompactStateResult {
  /** The compacted STATE.md content. */
  content: string;
  /** How many whole session-log entries were removed (always the oldest). */
  dropped: number;
}

const DEFAULT_SESSION_LOG_HEADING = /^##\s+session log\b/i;
const DEFAULT_ENTRY_HEADING = /^###\s+/;

/**
 * Compacts STATE.md to at most `maxLines` lines by dropping the oldest
 * session-log entries first. The head (everything up to and including the
 * session-log heading) is preserved verbatim even if it alone exceeds the
 * budget — this function shrinks the log, it never mangles the head.
 *
 * If no session-log heading is present the content is returned unchanged
 * (`dropped: 0`): there is nothing this can safely compact.
 */
export function compactState(
  content: string,
  maxLines: number,
  options: CompactStateOptions = {},
): CompactStateResult {
  const sessionLogHeading = options.sessionLogHeading ?? DEFAULT_SESSION_LOG_HEADING;
  const entryHeading = options.entryHeading ?? DEFAULT_ENTRY_HEADING;

  const hadTrailingNewline = content.endsWith("\n");
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = body.length === 0 ? [] : body.split("\n");

  const logHeadingIndex = lines.findIndex((line) => sessionLogHeading.test(line));
  if (logHeadingIndex === -1) {
    return { content, dropped: 0 };
  }

  // Head: everything up to and including the session-log heading — never dropped.
  const head = lines.slice(0, logHeadingIndex + 1);
  const rest = lines.slice(logHeadingIndex + 1);

  // Split the log body into a preamble (lines before the first entry, e.g. a
  // blank spacer) and the entries themselves, in file order (oldest first).
  const preamble: string[] = [];
  const entries: string[][] = [];
  let current: string[] | null = null;
  for (const line of rest) {
    if (entryHeading.test(line)) {
      current = [line];
      entries.push(current);
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }

  // Keep as many of the most recent entries as fit, dropping oldest first.
  let used = head.length + preamble.length;
  const kept: string[][] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entries[i].length;
    if (used + cost <= maxLines) {
      kept.unshift(entries[i]);
      used += cost;
    } else {
      // This entry doesn't fit; every older entry is dropped with it, so that
      // the kept entries stay a contiguous "most recent" suffix.
      break;
    }
  }

  const dropped = entries.length - kept.length;
  if (dropped === 0) {
    return { content, dropped: 0 };
  }

  const outLines = [...head, ...preamble, ...kept.flat()];
  const outBody = outLines.join("\n");
  return {
    content: hadTrailingNewline ? `${outBody}\n` : outBody,
    dropped,
  };
}
