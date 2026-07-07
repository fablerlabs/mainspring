/**
 * Adversarial red-team round 2 -- persistent fixture corpus.
 *
 * Round 1 (scrub.test.ts) covers one true-positive fixture per declared
 * pattern. Round 2 hardens against active evasion: zero-width characters
 * splitting a secret literal, a real secret buried inside an oversized blob,
 * and a set of benign lookalikes that must never false-positive. Every
 * mustCatch entry must produce >=1 finding via scan(); every mustPass entry
 * must produce zero findings.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { scan } from "../src/index.js";

// Resolved relative to the COMPILED test file (dist-test/test/redteam2.test.js),
// so this points back at the source-tree fixture -- tsc does not copy
// non-.ts files (like this corpus) into dist-test.
const CORPUS_PATH = fileURLToPath(new URL("../../test/fixtures/secret-corpus.json", import.meta.url));
const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

// mustCatch fixtures store secret-shaped strings as fragments so the repo's own
// publish scrub-gate never sees a contiguous secret shape in the fixture file.
const joined = (entry: { line?: string; lineParts?: string[] }): string =>
  entry.line ?? entry.lineParts!.join("");

interface CatchEntry {
  id: string;
  label: string;
  line?: string;
  lineParts?: string[];
  unit?: string;
  repeat?: number;
  prefixParts?: string[];
}

interface PassEntry {
  id: string;
  label: string;
  line: string;
}

for (const entry of corpus.mustCatch as CatchEntry[]) {
  test(`redteam2/${entry.id}: ${entry.label} -- must be caught`, () => {
    const content = entry.unit !== undefined ? `${entry.prefixParts?.join("") ?? ""}${entry.unit.repeat(entry.repeat!)}` : joined(entry);

    const start = performance.now();
    const findings = scan(content);
    const durationMs = performance.now() - start;
    assert.ok(durationMs < 5000, `${entry.id}: scan took ${durationMs.toFixed(0)}ms, expected well under 5s`);

    assert.ok(findings.length >= 1, `${entry.id}: expected at least one finding, got none`);
    for (const finding of findings) {
      assert.ok(finding.excerpt.includes("*"), `${entry.id}: excerpt must be redacted, got ${JSON.stringify(finding.excerpt)}`);
    }
  });
}

for (const entry of corpus.mustPass as PassEntry[]) {
  test(`redteam2/${entry.id}: ${entry.label} -- must NOT be flagged`, () => {
    const findings = scan(joined(entry));
    assert.equal(findings.length, 0, `${entry.id}: expected zero findings, got ${JSON.stringify(findings)}`);
  });
}

test("redteam2: corpus sanity -- at least 20 combined entries, both directions represented", () => {
  const total = corpus.mustCatch.length + corpus.mustPass.length;
  assert.ok(total >= 20, `expected at least 20 corpus entries, found ${total}`);
  assert.ok(corpus.mustCatch.length >= 10, "expected a substantial mustCatch set");
  assert.ok(corpus.mustPass.length >= 5, "expected a substantial mustPass set");
});
