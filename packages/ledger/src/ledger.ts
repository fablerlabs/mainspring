/**
 * LEDGER.csv: the append-only record of every dollar in or out of the
 * business, one row per entry, each row carrying the running balance so the
 * file is self-verifying — no separate accounting state to fall out of sync.
 *
 * The `Ledger` class is a pure in-memory model (parse, append, serialize);
 * `readLedger`/`appendLedger` are the disk-facing helpers, and `appendLedger`
 * only ever appends new bytes to an existing file. It never rewrites earlier
 * rows, so history can't be silently edited — a corrupted or hand-tampered
 * row is caught by the balance invariant instead of being loaded silently.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LedgerEntryType = "revenue" | "expense" | "refund" | "adjustment";

/** One entry to record. `amountUsd` is always a non-negative magnitude; sign is implied by `type`. */
export interface LedgerEntry {
  date: string; // ISO 8601
  type: LedgerEntryType;
  description: string;
  amountUsd: number;
}

/** A stored entry plus the running balance immediately after it. */
export interface LedgerRow extends LedgerEntry {
  balanceUsd: number;
}

export const LEDGER_CSV_HEADER = "date,type,description,amount_usd,balance_usd";

/** Thrown when a row is malformed or its balance doesn't match the running total. */
export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

const LEDGER_TYPES: readonly LedgerEntryType[] = ["revenue", "expense", "refund", "adjustment"];

function isLedgerType(value: string): value is LedgerEntryType {
  return (LEDGER_TYPES as readonly string[]).includes(value);
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Signed effect of one entry on the running balance. */
function delta(entry: Pick<LedgerEntry, "type" | "amountUsd">): number {
  switch (entry.type) {
    case "revenue":
      return entry.amountUsd;
    case "expense":
    case "refund":
      return -entry.amountUsd;
    case "adjustment":
      return 0;
    default: {
      const exhaustive: never = entry.type;
      throw new LedgerInvariantError(`unknown ledger entry type: ${String(exhaustive)}`);
    }
  }
}

function csvEscape(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

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

function rowToCsvLine(row: LedgerRow): string {
  return [
    row.date,
    row.type,
    csvEscape(row.description),
    row.amountUsd.toFixed(2),
    row.balanceUsd.toFixed(2),
  ].join(",");
}

function parseRow(line: string, lineNo: number): LedgerRow {
  const cols = parseCsvLine(line);
  if (cols.length !== 5) {
    throw new LedgerInvariantError(`ledger row ${lineNo}: expected 5 columns, got ${cols.length}`);
  }
  const [date, type, description, amountRaw, balanceRaw] = cols;
  if (!isLedgerType(type)) {
    throw new LedgerInvariantError(`ledger row ${lineNo}: unknown type "${type}"`);
  }
  const amountUsd = Number(amountRaw);
  const balanceUsd = Number(balanceRaw);
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new LedgerInvariantError(`ledger row ${lineNo}: invalid amount_usd "${amountRaw}"`);
  }
  if (!Number.isFinite(balanceUsd)) {
    throw new LedgerInvariantError(`ledger row ${lineNo}: invalid balance_usd "${balanceRaw}"`);
  }
  return { date, type, description, amountUsd, balanceUsd };
}

/**
 * In-memory ledger: an ordered, append-only list of rows each carrying the
 * running balance. There is no method to edit or remove a past row — the
 * only way to change the ledger is `append`, which always adds to the end.
 */
export class Ledger {
  #rows: LedgerRow[] = [];

  /** Rows in file order (oldest first). A fresh, frozen copy — mutating it cannot affect the ledger. */
  get entries(): readonly LedgerRow[] {
    return Object.freeze(this.#rows.slice());
  }

  /** The running balance after the last entry, or 0 for an empty ledger. */
  balance(): number {
    if (this.#rows.length === 0) return 0;
    return this.#rows[this.#rows.length - 1].balanceUsd;
  }

  /**
   * Appends one entry, computing its balance from the current running
   * balance, and returns the stored row. Always adds to the end.
   */
  append(entry: LedgerEntry): LedgerRow {
    if (!Number.isFinite(entry.amountUsd) || entry.amountUsd < 0) {
      throw new LedgerInvariantError(`amountUsd must be a non-negative finite number, got ${entry.amountUsd}`);
    }
    const balanceUsd = roundCents(this.balance() + delta(entry));
    const row: LedgerRow = Object.freeze({ ...entry, balanceUsd });
    this.#rows.push(row);
    return row;
  }

  /** Serializes the full ledger (header + every row) as LEDGER.csv text. */
  toCsv(): string {
    const lines = [LEDGER_CSV_HEADER, ...this.#rows.map(rowToCsvLine)];
    return `${lines.join("\n")}\n`;
  }

  /**
   * Parses a LEDGER.csv document into a Ledger. Every row's balance_usd must
   * equal the running balance implied by the prior rows plus its own
   * amount/type; a row that breaks that invariant throws rather than being
   * loaded silently, so a tampered or hand-edited file is caught at read time.
   */
  static fromCsv(csv: string): Ledger {
    const ledger = new Ledger();
    const lines = csv.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) return ledger;

    const header = lines[0].trim();
    if (header !== LEDGER_CSV_HEADER) {
      throw new LedgerInvariantError(`ledger header mismatch: expected "${LEDGER_CSV_HEADER}", got "${header}"`);
    }

    let running = 0;
    for (let i = 1; i < lines.length; i++) {
      const lineNo = i + 1;
      const parsed = parseRow(lines[i], lineNo);
      const expected = roundCents(running + delta(parsed));
      if (roundCents(parsed.balanceUsd) !== expected) {
        throw new LedgerInvariantError(
          `ledger row ${lineNo}: balance_usd ${parsed.balanceUsd.toFixed(2)} does not match running balance ${expected.toFixed(2)}`,
        );
      }
      running = expected;
      ledger.#rows.push(Object.freeze({ ...parsed, balanceUsd: running }));
    }
    return ledger;
  }
}

/** Absolute path to LEDGER.csv for a workspace. */
export function ledgerPath(workspaceDir: string): string {
  return join(workspaceDir, "LEDGER.csv");
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Reads LEDGER.csv into a Ledger, validating the balance invariant on every row. An absent file reads as empty. */
export async function readLedger(workspaceDir: string): Promise<Ledger> {
  const raw = await readTextIfExists(ledgerPath(workspaceDir));
  return raw === null ? new Ledger() : Ledger.fromCsv(raw);
}

/**
 * Appends one entry to LEDGER.csv on disk and returns the stored row. Reads
 * the current file only to validate the invariant and compute the new
 * balance; the write itself either creates the file (header + first row) or
 * appends just the new row's bytes — existing bytes on disk are never
 * touched, so a crash mid-write can lose at most the row being appended.
 */
export async function appendLedger(workspaceDir: string, entry: LedgerEntry): Promise<LedgerRow> {
  const path = ledgerPath(workspaceDir);
  const existing = await readTextIfExists(path);
  const ledger = existing === null ? new Ledger() : Ledger.fromCsv(existing);
  const row = ledger.append(entry);
  const line = rowToCsvLine(row);

  await mkdir(dirname(path), { recursive: true });
  if (existing === null) {
    await writeFile(path, `${LEDGER_CSV_HEADER}\n${line}\n`, "utf8");
  } else {
    const separator = existing.endsWith("\n") ? "" : "\n";
    await appendFile(path, `${separator}${line}\n`, "utf8");
  }
  return row;
}
