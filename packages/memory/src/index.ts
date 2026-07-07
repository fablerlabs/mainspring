/**
 * @mainspring/memory — durable, deterministic memory utilities for the
 * amnesiac session loop: STATE.md compaction, the per-day journal, and the
 * append-only session log. Zero runtime dependencies; no LLM calls.
 */

export {
  compactState,
  type CompactStateOptions,
  type CompactStateResult,
} from "./state.js";
export { appendJournal, tailJournal, journalPath } from "./journal.js";
export {
  appendSession,
  readSessions,
  lastSessions,
  sessionLogPath,
  type SessionLogEntry,
} from "./sessionLog.js";
