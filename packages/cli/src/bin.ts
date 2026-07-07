#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { doctor } from "./commands/doctor.js";
import { init } from "./commands/init.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";

function printHelp(): void {
  console.log(`mainspring — run a long-lived, autonomous, revenue-generating agent business

Usage:
  mainspring init <dir> [--name "My Business"] [--brain echo]
  mainspring run [--workspace .] [--no-commit]
  mainspring status [--workspace .]
  mainspring doctor [--workspace .]
`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "init":
      await init(args);
      return;
    case "run":
      await run(args);
      return;
    case "status":
      await status(args);
      return;
    case "doctor":
      await doctor(args);
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
