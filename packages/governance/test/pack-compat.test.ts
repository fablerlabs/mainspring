import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { MoneyCaps } from "../src/rules.js";
import { evaluate } from "../src/guard.js";
import { loadConstitutionFile } from "../src/loader.js";

/**
 * Compatibility test between @mainspring/governance and the $19 Constitution
 * Pack (product/constitution-packs/). The pack lives outside this package's
 * repo boundary (Mainspring is pushed to its own GitHub repo independently
 * of the business monorepo), so this fixture is a static copy of
 * product/constitution-packs/constitutions/CONSTITUTION.saas-support-agent.md
 * — not an import across that boundary. Keep the two in sync by hand if
 * either changes; see RESULT-q86.md for the sync process.
 */
const SAAS_SUPPORT_CONSTITUTION = fileURLToPath(
  new URL("../../test/fixtures/CONSTITUTION.saas-support-agent.md", import.meta.url),
);

// Same fragment-concatenation convention as governance.test.ts, so no
// contiguous secret-shaped literal appears in this source file.
const STRIPE_LIVE_KEY = "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dcREDACTED0";

const PACK_MONEY_CAPS: MoneyCaps = { perSessionUsd: 500, notifyAboveUsd: 20, approvalAboveUsd: 100 };

test("loadConstitutionFile: parses the SaaS support pack's Hard rules section (7 items) without throwing", async () => {
  const loaded = await loadConstitutionFile(SAAS_SUPPORT_CONSTITUTION);
  assert.equal(loaded.hardRules.length, 7);
  assert.ok(loaded.hardRules.every((r) => r.text.length > 0));
  assert.equal(loaded.rules.length, 5);
});

test("loadConstitutionFile: the pack's three marked rules attach their prose to the matching built-in rule", async () => {
  const loaded = await loadConstitutionFile(SAAS_SUPPORT_CONSTITUTION);

  // The pack marks hard rules 2, 4, and 6 with <!-- rule:ID --> — in that
  // document order — and no others.
  assert.deepEqual(
    loaded.hardRules.filter((r) => r.id).map((r) => r.id),
    ["honesty-disclosure", "spend-caps", "no-secrets"],
  );

  const honesty = loaded.rules.find((r) => r.id === "honesty-disclosure");
  assert.ok(honesty?.description.includes("Never claim to be human when directly asked"));

  const spendCaps = loaded.rules.find((r) => r.id === "spend-caps");
  assert.ok(spendCaps?.description.includes("Refunds, credits, and account actions only via the operator"));

  const noSecrets = loaded.rules.find((r) => r.id === "no-secrets");
  assert.ok(noSecrets?.description.includes("Secrets and customer PII never leave"));

  // The unmarked built-in rule keeps its stock description verbatim — the
  // pack doesn't force every rule to have a citation.
  const externalAllowlist = loaded.rules.find((r) => r.id === "external-allowlist");
  assert.ok(!externalAllowlist?.description.includes("constitution:"));
});

test("enforcement: a ticket reply leaking a secret is denied, citing the pack's own hard rule 6", async () => {
  const loaded = await loadConstitutionFile(SAAS_SUPPORT_CONSTITUTION);
  const action = { kind: "write" as const, path: "outbox/ticket-4821-reply.md", content: `internal note: STRIPE_SECRET_KEY=${STRIPE_LIVE_KEY}` };

  const result = evaluate(action, loaded.rules);

  assert.equal(result.verdict, "block");
  const fired = result.firedRules.find((f) => f.id === "no-secrets");
  assert.ok(fired, "no-secrets rule should have fired");
  assert.ok(fired.description.includes('(constitution: "'));
  assert.ok(fired.description.includes("Secrets and customer PII never leave"));
});

test("enforcement: a support macro claiming to be human is denied, citing the pack's own hard rule 2", async () => {
  const loaded = await loadConstitutionFile(SAAS_SUPPORT_CONSTITUTION);
  const undisclosed = evaluate({ kind: "run", tool: "reply-to-ticket", args: { text: "Hi, this is Sam from support!" } }, loaded.rules);

  assert.equal(undisclosed.verdict, "block");
  const fired = undisclosed.firedRules.find((f) => f.id === "honesty-disclosure");
  assert.ok(fired?.description.includes("Never claim to be human when directly asked"));

  const disclosed = evaluate(
    { kind: "run", tool: "reply-to-ticket", args: { text: "Hi, I'm the AI support agent!", disclosedAsAI: true } },
    loaded.rules,
  );
  assert.equal(disclosed.verdict, "allow");
});

test("enforcement: a refund past the pack's approval tier escalates, citing hard rule 4, and clears with an approval code", async () => {
  const withoutCode = await loadConstitutionFile(SAAS_SUPPORT_CONSTITUTION, { moneyCaps: PACK_MONEY_CAPS });
  const refund150 = {
    kind: "ledger" as const,
    entry: { date: "2026-07-07", type: "expense" as const, description: "refund: ticket 4821", amountUsd: 150 },
  };

  const escalated = evaluate(refund150, withoutCode.rules);
  assert.equal(escalated.verdict, "escalate");
  const fired = escalated.firedRules.find((f) => f.id === "spend-caps");
  assert.ok(fired?.description.includes("Refunds, credits, and account actions only via the operator"));

  const withCode = await loadConstitutionFile(SAAS_SUPPORT_CONSTITUTION, {
    moneyCaps: PACK_MONEY_CAPS,
    approvalCodePresent: true,
  });
  const cleared = evaluate(refund150, withCode.rules);
  assert.equal(cleared.verdict, "allow");
});

test("enforcement: an ordinary in-policy refund and reply are allowed outright", async () => {
  const loaded = await loadConstitutionFile(SAAS_SUPPORT_CONSTITUTION, { moneyCaps: PACK_MONEY_CAPS });

  const smallRefund = evaluate(
    { kind: "ledger", entry: { date: "2026-07-07", type: "expense", description: "refund: ticket 4900", amountUsd: 10 } },
    loaded.rules,
  );
  assert.equal(smallRefund.verdict, "allow");

  const reply = evaluate({ kind: "write", path: "outbox/ticket-4900-reply.md", content: "Refund issued, should post in 3-5 business days." }, loaded.rules);
  assert.equal(reply.verdict, "allow");
  assert.equal(reply.firedRules.length, 0);
});
