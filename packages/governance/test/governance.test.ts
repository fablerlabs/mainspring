import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createBuiltInRules, checkSpendPolicy, type Action, type MoneyCaps, type Rule } from "../src/rules.js";
import { evaluate } from "../src/guard.js";
import { parseHardRules, attachConstitutionDescriptions, loadConstitutionRules, loadConstitutionFile } from "../src/loader.js";

// Secret-shaped test fixture built from concatenated fragments so no
// contiguous secret-shaped literal appears in this source file (mirrors the
// convention used by @mainspring/scrub's own tests).
const STRIPE_LIVE_KEY = "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dcREDACTED0";

const HELLO_BUSINESS_CONSTITUTION = fileURLToPath(
  new URL("../../../../examples/hello-business/CONSTITUTION.md", import.meta.url),
);

const CAPS: MoneyCaps = { perSessionUsd: 100, notifyAboveUsd: 25, approvalAboveUsd: 75 };

function writeAction(content: string): Action {
  return { kind: "write", path: "outbox/post.md", content };
}

function ledgerExpense(amountUsd: number): Action {
  return { kind: "ledger", entry: { date: "2026-07-07", type: "expense", description: "test", amountUsd } };
}

// --- no-secrets --------------------------------------------------------------

test("no-secrets: blocks a write action whose content contains a secret-shaped string", () => {
  const rules = createBuiltInRules();
  const result = evaluate(writeAction(`STRIPE_SECRET_KEY=${STRIPE_LIVE_KEY}`), rules);
  assert.equal(result.verdict, "block");
  assert.ok(result.firedRules.some((f) => f.id === "no-secrets"));
});

test("no-secrets: allows a write action with ordinary content", () => {
  const rules = createBuiltInRules();
  const result = evaluate(writeAction("# Journal\n- did some honest work today"), rules);
  assert.equal(result.verdict, "allow");
  assert.equal(result.firedRules.length, 0);
});

test("no-secrets: blocks a notify action carrying a secret, and a run action whose args carry one", () => {
  const rules = createBuiltInRules();

  const notifyResult = evaluate({ kind: "notify", to: "owner", text: `key is ${STRIPE_LIVE_KEY}` }, rules);
  assert.equal(notifyResult.verdict, "block");

  const runResult = evaluate({ kind: "run", tool: "post-x", args: { text: STRIPE_LIVE_KEY, disclosedAsAI: true } }, rules);
  assert.equal(runResult.verdict, "block");
});

test("no-secrets: does not fire on actions with no free-form text (ledger, enqueue, relay, done)", () => {
  const rules = createBuiltInRules();
  const result = evaluate(ledgerExpense(1), rules);
  assert.ok(!result.firedRules.some((f) => f.id === "no-secrets"));
});

// --- spend-caps ----------------------------------------------------------------

test("checkSpendPolicy: allows a small expense under every threshold", () => {
  assert.equal(checkSpendPolicy({ type: "expense", amountUsd: 10 }, CAPS, 0, false), "allow");
});

test("checkSpendPolicy: escalates at/above notifyAboveUsd", () => {
  assert.equal(checkSpendPolicy({ type: "expense", amountUsd: 25 }, CAPS, 0, false), "escalate");
});

test("checkSpendPolicy: escalates at/above approvalAboveUsd without an approval code, allows with one", () => {
  assert.equal(checkSpendPolicy({ type: "expense", amountUsd: 75 }, CAPS, 0, false), "escalate");
  assert.equal(checkSpendPolicy({ type: "expense", amountUsd: 75 }, CAPS, 0, true), "allow");
});

test("checkSpendPolicy: blocks once projected session spend exceeds perSessionUsd, even with an approval code", () => {
  assert.equal(checkSpendPolicy({ type: "expense", amountUsd: 50 }, CAPS, 60, true), "block");
});

test("checkSpendPolicy: non-expense ledger entries are always allowed", () => {
  assert.equal(checkSpendPolicy({ type: "revenue", amountUsd: 1000 }, CAPS, 0, false), "allow");
});

test("spend-caps rule: wired through the guard end to end, and inert when no moneyCaps configured", () => {
  const withCaps = createBuiltInRules({ moneyCaps: CAPS, spentSoFarUsd: 0 });
  const blocked = evaluate(ledgerExpense(150), withCaps);
  assert.equal(blocked.verdict, "block");
  assert.ok(blocked.firedRules.some((f) => f.id === "spend-caps"));

  const noCaps = createBuiltInRules();
  const unrestricted = evaluate(ledgerExpense(999999), noCaps);
  assert.equal(unrestricted.verdict, "allow");
});

// --- external-allowlist ----------------------------------------------------------

test("external-allowlist: blocks a run action whose tool is not on the configured allowlist", () => {
  const rules = createBuiltInRules({ allowedTools: ["send-email"] });
  const result = evaluate({ kind: "run", tool: "delete-database", args: {} }, rules);
  assert.equal(result.verdict, "block");
  assert.ok(result.firedRules.some((f) => f.id === "external-allowlist"));
});

test("external-allowlist: allows a run action whose tool is on the allowlist", () => {
  const rules = createBuiltInRules({ allowedTools: ["send-email"] });
  const result = evaluate({ kind: "run", tool: "send-email", args: {} }, rules);
  assert.equal(result.verdict, "allow");
});

test("external-allowlist: is inert (allow) when no allowlist is configured", () => {
  const rules = createBuiltInRules();
  const result = evaluate({ kind: "run", tool: "anything-goes", args: {} }, rules);
  assert.ok(!result.firedRules.some((f) => f.id === "external-allowlist"));
});

// --- honesty-disclosure ----------------------------------------------------------

test("honesty-disclosure: blocks a post-shaped run action with no disclosedAsAI flag", () => {
  const rules = createBuiltInRules();
  const result = evaluate({ kind: "run", tool: "post-to-reddit", args: { text: "hello" } }, rules);
  assert.equal(result.verdict, "block");
  assert.ok(result.firedRules.some((f) => f.id === "honesty-disclosure"));
});

test("honesty-disclosure: allows a post-shaped run action that discloses AI authorship", () => {
  const rules = createBuiltInRules();
  const result = evaluate({ kind: "run", tool: "post-to-reddit", args: { text: "hello", disclosedAsAI: true } }, rules);
  assert.equal(result.verdict, "allow");
});

test("honesty-disclosure: does not apply to non-post-shaped tool names", () => {
  const rules = createBuiltInRules();
  const result = evaluate({ kind: "run", tool: "fetch-analytics", args: {} }, rules);
  assert.ok(!result.firedRules.some((f) => f.id === "honesty-disclosure"));
});

// --- guard precedence and never-throws --------------------------------------------

test("guard.evaluate: block wins over escalate wins over allow", () => {
  const rules: Rule[] = [
    { id: "a", description: "always allows", test: () => "allow" },
    { id: "e", description: "always escalates", test: () => "escalate" },
    { id: "b", description: "always blocks", test: () => "block" },
  ];
  const result = evaluate({ kind: "done" }, rules);
  assert.equal(result.verdict, "block");
  assert.deepEqual(
    result.firedRules.map((f) => f.id),
    ["e", "b"],
  );
});

test("guard.evaluate: escalate wins over allow when no rule blocks", () => {
  const rules: Rule[] = [
    { id: "a", description: "always allows", test: () => "allow" },
    { id: "e", description: "always escalates", test: () => "escalate" },
  ];
  const result = evaluate({ kind: "done" }, rules);
  assert.equal(result.verdict, "escalate");
});

test("guard.evaluate: a throwing rule never crashes evaluate, and is treated as escalate", () => {
  const rules: Rule[] = [
    {
      id: "boom",
      description: "throws unconditionally",
      test: () => {
        throw new Error("rule bug");
      },
    },
  ];
  const result = evaluate({ kind: "done" }, rules);
  assert.equal(result.verdict, "escalate");
  assert.ok(result.firedRules.some((f) => f.id === "boom"));
});

test("guard.evaluate: allows an action with an empty rule set", () => {
  const result = evaluate({ kind: "done" }, []);
  assert.equal(result.verdict, "allow");
  assert.equal(result.firedRules.length, 0);
});

// --- loader ------------------------------------------------------------------

test("parseHardRules: extracts each numbered bullet from a '## Hard rules' section, joining wrapped lines", () => {
  const markdown = [
    "# CONSTITUTION",
    "",
    "## Hard rules",
    "",
    "1. First rule wraps across",
    "   a second line.",
    "2. Second rule.",
    "",
    "## Money",
    "- not a hard rule",
  ].join("\n");

  const items = parseHardRules(markdown);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "First rule wraps across a second line.");
  assert.equal(items[1].text, "Second rule.");
  assert.equal(items[0].id, undefined);
});

test("parseHardRules: returns an empty list when there is no '## Hard rules' section", () => {
  assert.deepEqual(parseHardRules("# CONSTITUTION\n\n## Money\n- caps here"), []);
});

test("parseHardRules: extracts a <!-- rule:id --> marker and strips it from the visible text", () => {
  const markdown = ["## Hard rules", "1. No secrets leave this box. <!-- rule:no-secrets -->"].join("\n");
  const items = parseHardRules(markdown);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "no-secrets");
  assert.equal(items[0].text, "No secrets leave this box.");
});

test("attachConstitutionDescriptions: enriches a matching built-in rule's description, leaves unmatched rules untouched", () => {
  const rules = createBuiltInRules();
  const parsed = parseHardRules(["## Hard rules", "1. Never leak a key. <!-- rule:no-secrets -->"].join("\n"));
  const enriched = attachConstitutionDescriptions(rules, parsed);

  const noSecrets = enriched.find((r) => r.id === "no-secrets");
  assert.ok(noSecrets?.description.includes("Never leak a key."));

  const spendCaps = enriched.find((r) => r.id === "spend-caps");
  const original = rules.find((r) => r.id === "spend-caps");
  assert.equal(spendCaps?.description, original?.description);
});

test("loadConstitutionRules: best-effort loader never throws on a real-world constitution with no id markers", () => {
  const markdown = [
    "## Hard rules",
    "1. Legal and honest only.",
    "2. This is an AI-run operation and must never claim otherwise.",
  ].join("\n");

  const loaded = loadConstitutionRules(markdown);
  assert.equal(loaded.hardRules.length, 2);
  assert.equal(loaded.rules.length, createBuiltInRules().length);
  // No id markers present, so every rule keeps its built-in description verbatim.
  for (const rule of loaded.rules) {
    const builtin = createBuiltInRules().find((r) => r.id === rule.id);
    assert.equal(rule.description, builtin?.description);
  }
});

test("loadConstitutionFile: parses examples/hello-business/CONSTITUTION.md's Hard rules section", async () => {
  const loaded = await loadConstitutionFile(HELLO_BUSINESS_CONSTITUTION);
  assert.equal(loaded.hardRules.length, 6);
  assert.ok(loaded.hardRules.every((r) => r.text.length > 0));
  assert.ok(loaded.hardRules.some((r) => /never claim otherwise/i.test(r.text)));
  // The example constitution carries no <!-- rule:id --> markers, so this is a
  // best-effort no-op on descriptions — it must still resolve, not throw.
  assert.ok(loaded.hardRules.every((r) => r.id === undefined));
  assert.equal(loaded.rules.length, createBuiltInRules().length);
});
