import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Constitution,
  HealthReport,
  LedgerEntry,
  OwnerMessage,
  RelayRequest,
  SessionInput,
  ToolSpec,
  WorkOrder,
} from "./types.js";

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const items: T[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      items.push(JSON.parse(raw) as T);
    } catch {
      // Skip unreadable/malformed entries rather than fail the whole session.
    }
  }
  return items;
}

function parseLedgerCsv(csv: string): LedgerEntry[] {
  const lines = csv.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return []; // header only, or empty
  const rows = lines.slice(1);
  const entries: LedgerEntry[] = [];
  for (const row of rows) {
    const [date, type, description, amount] = row.split(",");
    if (!date || !type || amount === undefined) continue;
    entries.push({
      date,
      type: type as LedgerEntry["type"],
      description: description ?? "",
      amountUsd: Number(amount),
    });
  }
  return entries;
}

function todayJournalPath(workspaceDir: string): string {
  const iso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(workspaceDir, "journal", `${iso}.md`);
}

function spentThisSession(ledgerTail: LedgerEntry[]): number {
  return ledgerTail
    .filter((e) => e.type === "expense")
    .reduce((sum, e) => sum + e.amountUsd, 0);
}

/**
 * Reads a workspace directory on disk and builds the SessionInput a Brain
 * will see. This is the only place that touches the filesystem to gather
 * context — actions that change the filesystem go through dispatch.ts instead.
 */
export async function assemble(
  workspaceDir: string,
  constitution: Constitution,
  tools: ToolSpec[] = [],
): Promise<SessionInput> {
  await mkdir(join(workspaceDir, "journal"), { recursive: true });
  await mkdir(join(workspaceDir, "inbox"), { recursive: true });
  await mkdir(join(workspaceDir, "relay", "pending"), { recursive: true });
  await mkdir(join(workspaceDir, "queue"), { recursive: true });

  const state = await readTextIfExists(join(workspaceDir, "STATE.md"));
  const journalTail = await readTextIfExists(todayJournalPath(workspaceDir));
  const ledgerCsv = await readTextIfExists(join(workspaceDir, "LEDGER.csv"));
  const ledgerTail = parseLedgerCsv(ledgerCsv).slice(-20);

  const inbox = await readJsonDir<OwnerMessage>(join(workspaceDir, "inbox"));
  const pendingRelay = await readJsonDir<RelayRequest>(join(workspaceDir, "relay", "pending"));
  const queue = await readJsonDir<WorkOrder>(join(workspaceDir, "queue"));

  let health: HealthReport = { ok: true, lastSessionFailed: false, notes: [] };
  const healthRaw = await readTextIfExists(join(workspaceDir, "health.json"));
  if (healthRaw.trim()) {
    try {
      health = JSON.parse(healthRaw) as HealthReport;
    } catch {
      health = { ok: false, lastSessionFailed: false, notes: ["health.json is not valid JSON"] };
    }
  }

  const spentToday = spentThisSession(parseLedgerCsv(ledgerCsv));
  const remainingUSD = Math.max(0, constitution.moneyCaps.perSessionUsd - spentToday);

  return {
    constitution,
    state,
    journalTail,
    ledgerTail,
    inbox,
    health,
    pendingRelay,
    queue,
    tools,
    budget: {
      remainingUSD,
      sessionMs: constitution.maxSessionMs,
    },
  };
}
