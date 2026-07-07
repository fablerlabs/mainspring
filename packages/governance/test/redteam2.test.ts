/**
 * Adversarial red-team round 2 -- persistent fixture corpus.
 *
 * Round 1 (adversarial.test.ts) hand-wrote individual attack cases. Round 2
 * drives a much larger, versioned corpus (test/fixtures/injection-corpus.json)
 * through the public gate APIs so new attack shapes can be added as data
 * without touching test logic, and so a regression in any single entry shows
 * up by id.
 *
 * Invariant checked for every entry: fail CLOSED. Either the action is
 * blocked, or -- when there is genuinely nothing to block (inert prose with
 * no secret, no cap violation, no path escape) -- it is allowed with zero
 * fired rules. It must never throw uncaught, and it must never be allowed
 * when it should have been blocked.
 *
 * Note on prototype pollution: JSON cannot express a real prototype link --
 * `JSON.parse('{"__proto__":{"x":1}}')` produces a harmless own-property
 * named "__proto__", not an actual pollution of the object's prototype. The
 * corpus's `prototypePollutionAttacks` therefore cover the *textual shape* of
 * such payloads landing as inert write content. The two genuine prototype
 * attacks -- against honesty-disclosure and no-secrets -- require a real JS
 * object literal and are hand-written below, not corpus-driven.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createBuiltInRules, checkSpendPolicy, type Action, type MoneyCaps } from "../src/rules.js";
import { evaluate, type GuardResult } from "../src/guard.js";

// Resolved relative to the COMPILED test file (dist-test/test/redteam2.test.js),
// so this points back at the source-tree fixture -- same convention as
// governance.test.ts's HELLO_BUSINESS_CONSTITUTION path, since tsc does not
// copy non-.ts files (like this corpus) into dist-test.
const CORPUS_PATH = fileURLToPath(new URL("../../test/fixtures/injection-corpus.json", import.meta.url));
const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

// Fake, structurally-invalid secret assembled from fragments so no contiguous
// secret-shaped literal appears in this source file (same convention as
// adversarial.test.ts). X-padded, never a realistic live credential.
const FAKE_STRIPE_KEY = "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc" + "XXXXXXXX";

const DEFAULT_CAPS: MoneyCaps = { perSessionUsd: 100, notifyAboveUsd: 25, approvalAboveUsd: 75 };

function firedIds(result: GuardResult): string[] {
  return result.firedRules.map((f) => f.id);
}

interface TextEntry {
  id: string;
  category: string;
  label: string;
  text: string;
  pairWithSecret?: boolean;
  mustBlockAfterFix?: boolean;
  expectPatternGap?: boolean;
}

interface OversizedEntry {
  id: string;
  category: string;
  label: string;
  unit: string;
  repeat: number;
  pairWithSecret?: boolean;
  mustBlockAfterFix?: boolean;
}

interface MoneyEntry {
  id: string;
  category: string;
  label: string;
  amountUsd: unknown;
  spentSoFarUsd?: number;
  caps?: MoneyCaps;
  approvalCodePresent?: boolean;
  expectBlocked: boolean;
}

interface PathEntry {
  id: string;
  category: string;
  label: string;
  path: string;
  expectBlocked: boolean;
}

// =============================================================================
// Text-shaped attacks: prompt-injection, markdown/HTML smuggling, unicode
// homoglyphs, zero-width smuggling, and prototype-pollution-shaped prose --
// every one driven through evaluate() as a `write` action's content.
// =============================================================================

const textEntries: TextEntry[] = [...corpus.textAttacks, ...corpus.prototypePollutionAttacks];

for (const entry of textEntries) {
  test(`redteam2/${entry.id} (${entry.category}): ${entry.label}`, () => {
    const content = entry.pairWithSecret ? `${entry.text} ${FAKE_STRIPE_KEY}` : entry.text;
    const action: Action = { kind: "write", path: "outbox/post.md", content };

    let result: GuardResult;
    assert.doesNotThrow(() => {
      result = evaluate(action, createBuiltInRules());
    }, `${entry.id} must never throw uncaught through evaluate()`);
    result = evaluate(action, createBuiltInRules());

    if (entry.expectPatternGap) {
      // Documented, accepted limitation (see adversarial.test.ts's unicode
      // tool-name gap): a homoglyph inside the secret literal defeats the
      // ASCII-only shape regex. Assert the gap honestly rather than silently
      // passing -- if this ever starts firing, that's a welcome improvement,
      // not a break, so no assertion the other way is made.
      assert.ok(!firedIds(result).includes("no-secrets"), `${entry.id}: expected the documented pattern gap to still hold`);
      return;
    }

    if (entry.pairWithSecret || entry.mustBlockAfterFix) {
      assert.equal(result.verdict, "block", `${entry.id}: expected a real secret to be caught regardless of surrounding injection prose`);
      assert.ok(firedIds(result).includes("no-secrets"), `${entry.id}: expected no-secrets to fire`);
    } else {
      // Pure injection/smuggling prose with no actual secret or violation:
      // content is DATA. It must have zero effect on the verdict.
      assert.equal(result.verdict, "allow", `${entry.id}: inert prose must not itself trigger a block`);
      assert.equal(result.firedRules.length, 0, `${entry.id}: inert prose must fire no rules at all`);
    }
  });
}

// =============================================================================
// Oversized payloads (represented as {unit, repeat} specs, not literal
// megabytes in this file) -- must never crash, hang, or lose a real secret
// buried inside a huge blob.
// =============================================================================

for (const entry of corpus.oversizedAttacks as OversizedEntry[]) {
  test(`redteam2/${entry.id} (oversized): ${entry.label}`, () => {
    const blown = entry.unit.repeat(entry.repeat);
    const content =
      entry.id === "big-03"
        ? `sk_live_${blown}4eC39HqLyjWDarjtT1zdp7dcXXXXXXXX`
        : entry.pairWithSecret
          ? `${blown} ${FAKE_STRIPE_KEY}`
          : blown;
    const action: Action = { kind: "write", path: "outbox/post.md", content };

    const start = performance.now();
    const result = evaluate(action, createBuiltInRules());
    const durationMs = performance.now() - start;
    assert.ok(durationMs < 5000, `${entry.id}: took ${durationMs.toFixed(0)}ms, expected well under 5s (no ReDoS-shaped blowup)`);

    if (entry.pairWithSecret || entry.mustBlockAfterFix) {
      assert.equal(result.verdict, "block", `${entry.id}: a secret buried in a huge payload must still be caught`);
      assert.ok(firedIds(result).includes("no-secrets"));
    } else {
      assert.equal(result.verdict, "allow", `${entry.id}: a huge payload with no secret must still just be allowed`);
    }
  });
}

// =============================================================================
// Money-shaped attacks against checkSpendPolicy and the full guard.
// =============================================================================

for (const entry of corpus.moneyAttacks as MoneyEntry[]) {
  test(`redteam2/${entry.id} (money): ${entry.label}`, () => {
    const caps = entry.caps ?? DEFAULT_CAPS;
    const spentSoFarUsd = entry.spentSoFarUsd ?? 0;
    const approvalCodePresent = entry.approvalCodePresent ?? false;

    // A compromised brain builds the entry object directly, bypassing the
    // `amountUsd: number` type -- so the cast is the attack surface, not a
    // test artifact.
    const directVerdict = checkSpendPolicy(
      { type: "expense", amountUsd: entry.amountUsd as number },
      caps,
      spentSoFarUsd,
      approvalCodePresent,
    );

    // End to end through the guard as well.
    const rules = createBuiltInRules({ moneyCaps: caps, spentSoFarUsd, approvalCodePresent });
    const action: Action = {
      kind: "ledger",
      entry: { date: "2026-07-07", type: "expense", description: entry.label, amountUsd: entry.amountUsd as number },
    };
    let guardResult: GuardResult;
    assert.doesNotThrow(() => {
      guardResult = evaluate(action, rules);
    }, `${entry.id} must never throw uncaught`);
    guardResult = evaluate(action, rules);

    if (entry.expectBlocked) {
      assert.equal(directVerdict, "block", `${entry.id}: checkSpendPolicy must fail closed`);
      assert.equal(guardResult.verdict, "block", `${entry.id}: end-to-end guard must fail closed`);
      assert.ok(firedIds(guardResult).includes("spend-caps"));
    } else {
      assert.notEqual(directVerdict, "block", `${entry.id}: expected this amount not to be blocked`);
    }
  });
}

// =============================================================================
// Path-traversal attacks against `write` actions.
// =============================================================================

for (const entry of corpus.pathAttacks as PathEntry[]) {
  test(`redteam2/${entry.id} (path-traversal): ${entry.label}`, () => {
    const action: Action = { kind: "write", path: entry.path, content: "harmless content, not the point of this test" };
    let result: GuardResult;
    assert.doesNotThrow(() => {
      result = evaluate(action, createBuiltInRules());
    }, `${entry.id} must never throw uncaught`);
    result = evaluate(action, createBuiltInRules());

    if (entry.expectBlocked) {
      assert.equal(result.verdict, "block", `${entry.id}: expected path ${JSON.stringify(entry.path)} to be blocked`);
      assert.ok(firedIds(result).includes("path-traversal"));
    } else {
      assert.equal(result.verdict, "allow", `${entry.id}: expected an ordinary path to be allowed`);
      assert.ok(!firedIds(result).includes("path-traversal"));
    }
  });
}

// =============================================================================
// Genuine (non-JSON-representable) prototype pollution: a real object
// literal whose __proto__ sets the actual prototype chain, so plain property
// access resolves an inherited value as if it were declared on the object.
// =============================================================================

test("redteam2/proto-real-01: an inherited disclosedAsAI via a real __proto__ literal does not fake disclosure", () => {
  const args = Object.assign(Object.create({ disclosedAsAI: true }), { text: "hello world" });
  // Sanity: property access really does resolve the inherited value, and it
  // really is not an own property -- otherwise this test would be vacuous.
  assert.equal((args as { disclosedAsAI?: boolean }).disclosedAsAI, true);
  assert.equal(Object.prototype.hasOwnProperty.call(args, "disclosedAsAI"), false);

  const action: Action = { kind: "run", tool: "post-to-hn", args };
  const result = evaluate(action, createBuiltInRules());
  assert.equal(result.verdict, "block", "an inherited (non-own) disclosedAsAI must not count as disclosure");
  assert.ok(firedIds(result).includes("honesty-disclosure"));
});

test("redteam2/proto-real-02: a secret hidden on args' prototype is still caught (not invisible to JSON.stringify-only scanning)", () => {
  const args = Object.assign(Object.create({ leaked: FAKE_STRIPE_KEY }), { note: "nothing to see in the own properties" });
  assert.equal(JSON.stringify(args), '{"note":"nothing to see in the own properties"}', "sanity: JSON.stringify alone would miss this");

  const action: Action = { kind: "run", tool: "fetch-analytics", args };
  const result = evaluate(action, createBuiltInRules());
  assert.equal(result.verdict, "block", "a secret reachable only via the prototype chain must still be caught");
  assert.ok(firedIds(result).includes("no-secrets"));
});

test("redteam2: corpus sanity -- at least 30 entries across every declared attack category", () => {
  const all = [
    ...corpus.textAttacks,
    ...corpus.moneyAttacks,
    ...corpus.pathAttacks,
    ...corpus.prototypePollutionAttacks,
    ...corpus.oversizedAttacks,
  ];
  assert.ok(all.length >= 30, `expected at least 30 corpus entries, found ${all.length}`);
  const categories = new Set(all.map((e: { category: string }) => e.category));
  for (const expected of [
    "prompt-injection",
    "markdown-html-smuggling",
    "unicode-homoglyph",
    "zero-width",
    "money",
    "path-traversal",
    "prototype-pollution",
    "oversized",
  ]) {
    assert.ok(categories.has(expected), `expected corpus to cover category "${expected}"`);
  }
});
