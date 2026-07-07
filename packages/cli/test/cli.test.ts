import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { doctor } from "../src/commands/doctor.js";
import { status } from "../src/commands/status.js";
import type { ParsedArgs } from "../src/args.js";

// dist-test/test/cli.test.js -> dist-test/test -> dist-test -> cli -> packages -> mainspring
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = resolve(__dirname, "..", "..", "..", "..", "examples", "hello-business");

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

function argsFor(workspace: string): ParsedArgs {
  return { positionals: [], flags: { workspace } };
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
