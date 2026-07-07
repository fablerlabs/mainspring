import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { MainspringConfig } from "@mainspring/core";
import type { ParsedArgs } from "../args.js";
import { loadConfig } from "../loadConfig.js";

const execFileAsync = promisify(execFile);

/**
 * `mainspring doctor` — the first command a new user runs. It answers one
 * question: "is this workspace actually runnable?" — WITHOUT touching the
 * network, spending anything, or mutating state. Every check reports one of
 * three levels:
 *
 *   PASS — the check is satisfied.
 *   WARN — non-fatal; the workspace runs, but something is worth knowing
 *          (e.g. LEDGER.csv is created on first `run`, git is optional if you
 *          only ever `run --no-commit`).
 *   FAIL — the workspace cannot run correctly as-is.
 *
 * doctor exits nonzero if any check FAILs, so it is safe to gate CI / a setup
 * script on `mainspring doctor`.
 */
type Level = "PASS" | "WARN" | "FAIL";

interface Check {
  name: string;
  level: Level;
  detail: string;
}

/** Node built-in `access` as a boolean existence probe. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function checkNodeVersion(): Check {
  const [major] = process.versions.node.split(".").map(Number);
  return {
    name: "node >= 18",
    level: major >= 18 ? "PASS" : "FAIL",
    detail: `node ${process.versions.node}`,
  };
}

async function checkGit(): Promise<Check> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    return { name: "git available", level: "PASS", detail: stdout.trim().split("\n")[0] };
  } catch {
    // Not fatal: `mainspring run --no-commit` works without git. Warn so the
    // default (auto-commit) failure mode isn't a surprise later.
    return { name: "git available", level: "WARN", detail: "git not found — `run` can't auto-commit; use --no-commit" };
  }
}

async function checkRequiredFile(workspaceDir: string, file: string, missingLevel: Level): Promise<Check> {
  const present = await fileExists(join(workspaceDir, file));
  if (present) return { name: `${file} present`, level: "PASS", detail: file };
  const detail =
    missingLevel === "WARN"
      ? `not found — created on first \`mainspring run\``
      : `not found in workspace`;
  return { name: `${file} present`, level: missingLevel, detail };
}

/**
 * Loads mainspring.config.ts once and derives both the "config loads" and
 * "brain configured" checks from the result, so we never transpile the config
 * twice. A load failure surfaces its first message line (usually "No
 * mainspring.config.ts found ..." or a module-resolution error) as the detail.
 */
async function checkConfig(workspaceDir: string): Promise<{ config: Check; brain: Check }> {
  let loaded: MainspringConfig | null = null;
  let error: string | null = null;
  try {
    loaded = await loadConfig(workspaceDir);
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  }

  if (!loaded) {
    return {
      config: { name: "mainspring.config.ts loads", level: "FAIL", detail: error ?? "failed to load" },
      brain: { name: "brain configured", level: "FAIL", detail: "config did not load" },
    };
  }

  const config: Check = {
    name: "mainspring.config.ts loads",
    level: "PASS",
    detail: `constitution "${loaded.constitution?.name ?? "(unnamed)"}"`,
  };

  const brain = loaded.brain;
  const brainOk = !!brain && typeof brain.id === "string" && brain.id.length > 0;
  return {
    config,
    brain: brainOk
      ? { name: "brain configured", level: "PASS", detail: `${brain.id} (${brain.model})` }
      : { name: "brain configured", level: "FAIL", detail: "config has no usable `brain`" },
  };
}

export async function doctor(args: ParsedArgs = { positionals: [], flags: {} }): Promise<void> {
  const workspaceDir = resolve(
    process.cwd(),
    typeof args.flags.workspace === "string" ? args.flags.workspace : ".",
  );

  const { config, brain } = await checkConfig(workspaceDir);

  const checks: Check[] = [
    checkNodeVersion(),
    await checkGit(),
    await checkRequiredFile(workspaceDir, "CONSTITUTION.md", "FAIL"),
    await checkRequiredFile(workspaceDir, "STATE.md", "FAIL"),
    // LEDGER.csv is created by the first `run`; its absence is a warning, not a fault.
    await checkRequiredFile(workspaceDir, "LEDGER.csv", "WARN"),
    config,
    brain,
  ];

  console.log(`mainspring doctor — ${workspaceDir}\n`);
  let failures = 0;
  let warnings = 0;
  for (const check of checks) {
    if (check.level === "FAIL") failures++;
    if (check.level === "WARN") warnings++;
    console.log(`  ${check.level}  ${check.name} — ${check.detail}`);
  }

  console.log("");
  if (failures > 0) {
    console.log(`✖ ${failures} check(s) failed${warnings ? `, ${warnings} warning(s)` : ""}. Fix the FAILs above before \`mainspring run\`.`);
    process.exitCode = 1;
  } else if (warnings > 0) {
    console.log(`✓ Runnable, with ${warnings} warning(s). Review the WARNs above.`);
  } else {
    console.log(`✓ All checks passed — this workspace is ready for \`mainspring run\`.`);
  }
}
