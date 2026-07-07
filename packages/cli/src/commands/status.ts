import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MainspringConfig } from "@mainspring/core";
import type { ParsedArgs } from "../args.js";
import { loadConfig } from "../loadConfig.js";

/**
 * `mainspring status` — a compact, read-only snapshot of a workspace: who's
 * running it (the configured Brain), where the money stands (the last balance
 * in LEDGER.csv), and where the state is at (the STATE.md heading, plus the
 * most recent session-log entry if there is one).
 *
 * It reads only files on disk, touches no network, and mutates nothing. Every
 * source is optional: a brand-new workspace that has never `run` has no
 * LEDGER.csv and maybe a bare STATE.md, so each missing piece degrades to a
 * WARN line rather than crashing.
 */

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Parses one CSV line, honoring double-quoted fields (a description may contain
 * commas). Enough to pull the trailing balance column out of a LEDGER.csv row
 * without depending on the ledger package or adding a CSV dependency.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"' && cur.length === 0) {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

interface LedgerSummary {
  /** WARN text when there is nothing to report, else null. */
  warn: string | null;
  balance: number;
  entries: number;
}

/**
 * Reads LEDGER.csv and returns the trailing balance (last column of the last
 * data row) and a row count. Handles the two header shapes shipped by this
 * repo (`...,amount,balance` and `...,amount_usd,balance_usd`) uniformly: the
 * balance is always the last column. An empty/header-only file is $0.00 / 0
 * entries; a missing file is a WARN.
 */
function summarizeLedger(csv: string | null): LedgerSummary {
  if (csv === null) {
    return { warn: "no LEDGER.csv yet — created on first `mainspring run`", balance: 0, entries: 0 };
  }
  const lines = csv.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  // First line is the header; everything after it is a data row.
  const dataRows = lines.slice(1);
  if (dataRows.length === 0) {
    return { warn: null, balance: 0, entries: 0 };
  }
  const last = parseCsvLine(dataRows[dataRows.length - 1]);
  const balance = Number(last[last.length - 1]);
  if (!Number.isFinite(balance)) {
    return { warn: `LEDGER.csv present but last balance is unreadable ("${last[last.length - 1]}")`, balance: 0, entries: dataRows.length };
  }
  return { warn: null, balance, entries: dataRows.length };
}

interface StateSummary {
  /** WARN text when STATE.md is missing, else null. */
  warn: string | null;
  /** The STATE.md title (first `#` heading), or null. */
  title: string | null;
  /** The most recent session-log entry heading (`### ...`), or null if none. */
  latestEntry: string | null;
}

function summarizeState(md: string | null): StateSummary {
  if (md === null) {
    return { warn: "no STATE.md yet — run `mainspring init` to scaffold one", title: null, latestEntry: null };
  }
  const lines = md.split("\n");
  const titleLine = lines.find((l) => /^#\s+\S/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : null;
  // Session-log entries are `### ` sub-headings; the last one is "where we are".
  let latestEntry: string | null = null;
  for (const l of lines) {
    if (/^###\s+\S/.test(l)) latestEntry = l.replace(/^###\s+/, "").trim();
  }
  return { warn: title ? null : "STATE.md present but has no `#` title heading", title, latestEntry };
}

export async function status(args: ParsedArgs): Promise<void> {
  const workspaceDir = resolve(
    process.cwd(),
    typeof args.flags.workspace === "string" ? args.flags.workspace : ".",
  );

  // Config is a nice-to-have here (brain name); status must work without it.
  let config: MainspringConfig | null = null;
  let configError: string | null = null;
  try {
    config = await loadConfig(workspaceDir);
  } catch (err) {
    configError = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  }

  const [stateMd, ledgerCsv] = await Promise.all([
    readTextIfExists(join(workspaceDir, "STATE.md")),
    readTextIfExists(join(workspaceDir, "LEDGER.csv")),
  ]);

  const ledger = summarizeLedger(ledgerCsv);
  const state = summarizeState(stateMd);

  console.log(`mainspring status — ${workspaceDir}\n`);

  if (config?.brain) {
    console.log(`  Brain:    ${config.brain.id} (${config.brain.model})`);
  } else {
    console.log(`  Brain:    WARN — mainspring.config.ts did not load${configError ? ` (${configError})` : ""}`);
  }

  if (ledger.warn) {
    console.log(`  Balance:  WARN — ${ledger.warn}`);
  } else {
    const noun = ledger.entries === 1 ? "entry" : "entries";
    console.log(`  Balance:  $${ledger.balance.toFixed(2)}  (${ledger.entries} ledger ${noun})`);
  }

  if (state.warn) {
    console.log(`  State:    WARN — ${state.warn}`);
  } else {
    const latest = state.latestEntry ? `  ·  latest: ${state.latestEntry}` : "";
    console.log(`  State:    ${state.title}${latest}`);
  }
}
