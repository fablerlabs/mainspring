import { resolve } from "node:path";
import { runSession } from "@mainspring/core";
import type { ParsedArgs } from "../args.js";
import { loadConfig } from "../loadConfig.js";

export async function run(args: ParsedArgs): Promise<void> {
  const workspaceDir = resolve(process.cwd(), typeof args.flags.workspace === "string" ? args.flags.workspace : ".");
  const config = await loadConfig(workspaceDir);

  const summary = await runSession({
    workspaceDir,
    constitution: config.constitution,
    brain: config.brain,
    commit: args.flags["no-commit"] !== true,
  });

  console.log(`Session done in ${summary.steps} step(s).`);
  console.log(`  actions proposed: ${summary.actionsProposed}`);
  console.log(`  actions allowed:  ${summary.actionsAllowed}`);
  console.log(`  actions blocked:  ${summary.actionsBlocked}`);
  if (summary.blockedReasons.length > 0) {
    console.log(`  blocked reasons:`);
    for (const reason of summary.blockedReasons) console.log(`    - ${reason}`);
  }
  console.log(`  spent this session: $${summary.spentUsd.toFixed(2)}`);
}
