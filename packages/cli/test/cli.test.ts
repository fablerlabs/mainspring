import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { doctor } from "../src/commands/doctor.js";
import { init } from "../src/commands/init.js";
import { run } from "../src/commands/run.js";
import { status } from "../src/commands/status.js";
import type { ParsedArgs } from "../src/args.js";

// dist-test/test/cli.test.js -> dist-test/test -> dist-test -> cli -> packages -> mainspring
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const EXAMPLE_DIR = resolve(REPO_ROOT, "examples", "hello-business");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Args for `init <dir> [--flag value]...`. */
function initArgs(dir: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { positionals: [dir], flags };
}

/**
 * The scaffolded workspace's own next step is `pnpm add @mainspring/core` —
 * doctor/run load `mainspring.config.ts`, which imports it. Tests stand in for
 * that install with a direct node_modules symlink to this repo's built
 * `packages/core`, so resolution works from a clean checkout (no reliance on
 * hoisted links at the workspace root).
 */
async function linkCore(dir: string): Promise<void> {
  const scope = join(dir, "node_modules", "@mainspring");
  await mkdir(scope, { recursive: true });
  await symlink(resolve(REPO_ROOT, "packages", "core"), join(scope, "core"), "dir");
}

/** Runs a command function, capturing everything it writes to console.log and
 * the process.exitCode it leaves behind. Restores both afterwards so tests
 * don't leak the global exit code into each other or into node --test itself. */
async function capture(fn: () => Promise<void>): Promise<{ out: string; exitCode: number }> {
  const originalLog = console.log;
  const originalExit = process.exitCode;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map((p) => String(p)).join(" "));
  };
  process.exitCode = 0;
  try {
    await fn();
    return { out: lines.join("\n"), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = originalLog;
    process.exitCode = originalExit;
  }
}

function argsFor(workspace: string, extra: Record<string, string | boolean> = {}): ParsedArgs {
  return { positionals: [], flags: { workspace, ...extra } };
}

// --- doctor -----------------------------------------------------------------

test("doctor reports the expected checks against examples/hello-business and passes", async () => {
  const { out, exitCode } = await capture(() => doctor(argsFor(EXAMPLE_DIR)));

  // The full check list the work order requires must appear by name.
  assert.match(out, /node >= 18/, "node version check must appear");
  assert.match(out, /CONSTITUTION\.md present/, "CONSTITUTION.md check must appear");
  assert.match(out, /STATE\.md present/, "STATE.md check must appear");
  assert.match(out, /LEDGER\.csv present/, "LEDGER.csv check must appear");
  assert.match(out, /mainspring\.config\.ts loads/, "config-load check must appear");
  assert.match(out, /brain configured/, "brain check must appear");

  // hello-business is a complete, runnable workspace: no FAILs, exit 0.
  assert.doesNotMatch(out, /^\s*FAIL\s/m, `no check should FAIL against the example:\n${out}`);
  assert.equal(exitCode, 0, "doctor should exit 0 when the example workspace is healthy");
});

test("doctor exits nonzero when CONSTITUTION.md is absent", async () => {
  // A temp workspace with STATE.md but no CONSTITUTION.md — the missing
  // constitution alone must drive a FAIL and a nonzero exit.
  const dir = await mkdtemp(join(tmpdir(), "mainspring-cli-doctor-"));
  await writeFile(join(dir, "STATE.md"), "# STATE — Temp\n\n## Status\nok\n", "utf8");

  const { out, exitCode } = await capture(() => doctor(argsFor(dir)));

  assert.match(out, /FAIL\s+CONSTITUTION\.md present/, "CONSTITUTION.md should be reported as FAIL");
  assert.notEqual(exitCode, 0, "doctor must exit nonzero when a required file is missing");
});

// --- init -------------------------------------------------------------------

test("init scaffolds a workspace that doctor passes with exit 0", async () => {
  // A brand-new workspace in an empty temp dir must be doctor-clean. The dir
  // lives under the repo root so the workspace's node module resolution finds
  // @mainspring/core when doctor loads mainspring.config.ts.
  const dir = await mkdtemp(join(REPO_ROOT, "tmp-init-doctor-"));
  try {
    const initRes = await capture(() => init(initArgs(dir, { name: "Doctor Test Co" })));
    assert.equal(initRes.exitCode, 0, `init should succeed:\n${initRes.out}`);
    await linkCore(dir);

    // Every deliverable file/dir the work order names is present.
    assert.ok(await fileExists(join(dir, "CONSTITUTION.md")), "CONSTITUTION.md written");
    assert.ok(await fileExists(join(dir, "STATE.md")), "STATE.md written");
    assert.ok(await fileExists(join(dir, "LEDGER.csv")), "LEDGER.csv written");
    assert.ok(await fileExists(join(dir, "mainspring.config.ts")), "mainspring.config.ts written");
    assert.ok(await fileExists(join(dir, "journal")), "journal/ dir created");

    // --name is substituted into both prose and the machine-readable config.
    const constitution = await readFile(join(dir, "CONSTITUTION.md"), "utf8");
    assert.match(constitution, /CONSTITUTION — Doctor Test Co/, "name substituted into CONSTITUTION.md");
    assert.doesNotMatch(constitution, /\{\{BUSINESS_NAME\}\}/, "no unsubstituted token remains");
    // Default template is the minimal one.
    assert.match(constitution, /trimmed-down starting point|Per-session spend cap/, "minimal template body");

    const ledger = await readFile(join(dir, "LEDGER.csv"), "utf8");
    assert.match(ledger, /^date,type,description,amount,balance/, "LEDGER.csv has the header row");

    // The generated project README carries the honest, removable attribution
    // footer (github-search backlink), with --name substituted into the title.
    assert.ok(await fileExists(join(dir, "README.md")), "README.md written");
    const readme = await readFile(join(dir, "README.md"), "utf8");
    assert.match(readme, /Built on Mainspring — github\.com\/fablerlabs\/mainspring/, "README carries the Mainspring attribution footer");
    assert.match(readme, /# Doctor Test Co/, "name substituted into README title");
    assert.doesNotMatch(readme, /\{\{BUSINESS_NAME\}\}/, "no unsubstituted token remains in README");

    // The whole point: doctor is clean, exit 0.
    const doctorRes = await capture(() => doctor(argsFor(dir)));
    assert.doesNotMatch(doctorRes.out, /^\s*FAIL\s/m, `no check should FAIL after init:\n${doctorRes.out}`);
    assert.equal(doctorRes.exitCode, 0, "doctor exits 0 on a freshly-init'd workspace");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --template full writes the kitchen-sink Constitution", async () => {
  const dir = await mkdtemp(join(REPO_ROOT, "tmp-init-full-"));
  try {
    const res = await capture(() => init(initArgs(dir, { name: "Full Co", template: "full" })));
    assert.equal(res.exitCode, 0, `init --template full should succeed:\n${res.out}`);
    const constitution = await readFile(join(dir, "CONSTITUTION.md"), "utf8");
    assert.match(constitution, /kitchen-sink template/, "full template body present");
    assert.match(constitution, /CONSTITUTION — Full Co/, "name substituted in full template");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init then run --no-commit executes the echo Brain end to end", async () => {
  const dir = await mkdtemp(join(REPO_ROOT, "tmp-init-run-"));
  try {
    const initRes = await capture(() => init(initArgs(dir, { name: "Run Test Co" })));
    assert.equal(initRes.exitCode, 0, `init should succeed:\n${initRes.out}`);
    await linkCore(dir);

    const runRes = await capture(() => run(argsFor(dir, { "no-commit": true })));
    assert.equal(runRes.exitCode, 0, `run should succeed:\n${runRes.out}`);
    assert.match(runRes.out, /Session done in \d+ step\(s\)/, "run reports a session summary");
    assert.match(runRes.out, /spent this session: \$0\.00/, "echo Brain spends nothing");

    // The echo Brain writes a journal heartbeat for today — proof the loop ran.
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(await fileExists(join(dir, "journal", `${today}.md`)), "today's journal heartbeat exists");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init refuses a non-empty dir without --force, and proceeds with it", async () => {
  const dir = await mkdtemp(join(REPO_ROOT, "tmp-init-force-"));
  try {
    // Make the dir non-empty.
    await writeFile(join(dir, "preexisting.txt"), "hello\n", "utf8");

    const refused = await capture(() => init(initArgs(dir, { name: "Force Co" })));
    assert.notEqual(refused.exitCode, 0, "init must refuse a non-empty dir without --force");
    assert.equal(await fileExists(join(dir, "CONSTITUTION.md")), false, "nothing scaffolded on refusal");

    const forced = await capture(() => init(initArgs(dir, { name: "Force Co", force: true })));
    assert.equal(forced.exitCode, 0, `--force should override the refusal:\n${forced.out}`);
    assert.ok(await fileExists(join(dir, "CONSTITUTION.md")), "workspace scaffolded with --force");
    assert.ok(await fileExists(join(dir, "preexisting.txt")), "--force preserves preexisting files");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- status -----------------------------------------------------------------

test("status prints the balance and STATE heading for examples/hello-business", async () => {
  const { out, exitCode } = await capture(() => status(argsFor(EXAMPLE_DIR)));

  // Empty ledger (header only) => $0.00. STATE.md title => "STATE — Hello Business".
  assert.match(out, /Balance:\s+\$0\.00/, `status should print a $0.00 balance:\n${out}`);
  assert.match(out, /State:\s+STATE — Hello Business/, `status should print the STATE.md heading:\n${out}`);
  // status is read-only; it never sets a failing exit code.
  assert.equal(exitCode, 0, "status should not fail on a healthy workspace");
});

test("status degrades gracefully (WARN, no crash) when STATE.md and LEDGER.csv are missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mainspring-cli-status-"));

  const { out, exitCode } = await capture(() => status(argsFor(dir)));

  assert.match(out, /Balance:\s+WARN/, "missing LEDGER.csv should WARN, not crash");
  assert.match(out, /State:\s+WARN/, "missing STATE.md should WARN, not crash");
  assert.equal(exitCode, 0, "status should not throw or set a nonzero exit code on missing files");
});

test("status reads the trailing balance from a populated LEDGER.csv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mainspring-cli-status-bal-"));
  await writeFile(join(dir, "STATE.md"), "# STATE — Money Co\n\n## Status\nrunning\n", "utf8");
  await writeFile(
    join(dir, "LEDGER.csv"),
    [
      "date,type,description,amount_usd,balance_usd",
      "2026-01-01,revenue,first sale,29.00,29.00",
      // A quoted description containing a comma must not break the parse.
      '2026-01-02,expense,"hosting, monthly",5.00,24.00',
    ].join("\n") + "\n",
    "utf8",
  );

  const { out } = await capture(() => status(argsFor(dir)));

  assert.match(out, /Balance:\s+\$24\.00\s+\(2 ledger entries\)/, `expected trailing balance $24.00 / 2 entries:\n${out}`);
  assert.match(out, /State:\s+STATE — Money Co/);
});
