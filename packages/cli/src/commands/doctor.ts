import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkCommand(name: string, command: string, args: string[]): Promise<Check> {
  try {
    const { stdout } = await execFileAsync(command, args);
    return { name, ok: true, detail: stdout.trim().split("\n")[0] };
  } catch (err) {
    return { name, ok: false, detail: `not found or failed: ${(err as Error).message}` };
  }
}

function checkNodeVersion(): Check {
  const [major] = process.versions.node.split(".").map(Number);
  const ok = major >= 18;
  return { name: "node >= 18", ok, detail: `node ${process.versions.node}` };
}

export async function doctor(): Promise<void> {
  const checks: Check[] = [
    checkNodeVersion(),
    await checkCommand("git", "git", ["--version"]),
  ];

  let allOk = true;
  for (const check of checks) {
    allOk &&= check.ok;
    console.log(`${check.ok ? "OK  " : "FAIL"}  ${check.name} — ${check.detail}`);
  }

  if (!allOk) {
    process.exitCode = 1;
  }
}
