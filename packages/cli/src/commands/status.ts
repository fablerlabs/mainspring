import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ParsedArgs } from "../args.js";

export async function status(args: ParsedArgs): Promise<void> {
  const workspaceDir = resolve(process.cwd(), typeof args.flags.workspace === "string" ? args.flags.workspace : ".");
  const summaryPath = join(workspaceDir, ".mainspring", "last-session.json");

  let raw: string;
  try {
    raw = await readFile(summaryPath, "utf8");
  } catch {
    console.log(`No session recorded yet in ${workspaceDir}. Run "mainspring run" first.`);
    return;
  }

  const summary = JSON.parse(raw);
  console.log(`Last session: ${summary.startedAt} -> ${summary.endedAt}`);
  console.log(`  done: ${summary.done}`);
  console.log(`  steps: ${summary.steps}`);
  console.log(`  actions: ${summary.actionsAllowed} allowed, ${summary.actionsBlocked} blocked`);
  console.log(`  spent: $${Number(summary.spentUsd).toFixed(2)}`);
  console.log(`  commit: ${summary.commitDetail}`);
  if (summary.blockedReasons?.length) {
    console.log(`  blocked reasons:`);
    for (const reason of summary.blockedReasons) console.log(`    - ${reason}`);
  }
}
