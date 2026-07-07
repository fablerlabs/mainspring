// Step (a): a constitution with two real hard rules, enforced as code.
import { loadConstitutionRules, evaluate } from "@mainspring/governance";

const CONSTITUTION_MD = `# CONSTITUTION — Nightshift Notes (a tiny digital business)

## Mission
Sell one honest digital product and never do anything I'd be ashamed to explain.

## Hard rules
1. You are an AI and never claim otherwise when posting or publishing. <!-- rule:honesty-disclosure -->
2. Every dollar of spend respects the session caps; over-cap spend needs the owner's approval code. <!-- rule:spend-caps -->
`;

// The caps the spend rule enforces. These are the same thresholds the
// Constitution's prose describes, expressed as numbers the gate can check.
const { hardRules, rules } = loadConstitutionRules(CONSTITUTION_MD, {
  moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
  spentSoFarUsd: 0,
  approvalCodePresent: false,
  allowedTools: ["post-to-reddit"],
});

console.log(`Parsed ${hardRules.length} hard rules; built ${rules.length} enforceable guards.\n`);

const proposed = [
  // Compliant: an honest local write.
  { kind: "write", path: "notes/launch-copy.md", content: "Written by an AI. No fake reviews." },
  // Violates hard rule 1: a public post that hides that it's AI-authored.
  { kind: "run", tool: "post-to-reddit", args: { text: "trust me, this tool is amazing" } },
  // Violates hard rule 2: a $120 spend with no approval code present.
  { kind: "ledger", entry: { date: "2026-07-07", type: "expense", description: "ads", amountUsd: 120 } },
];

for (const action of proposed) {
  const { verdict, firedRules } = evaluate(action, rules);
  const why = firedRules.map((r) => `${r.id} → ${r.verdict}`).join(", ") || "clean";
  console.log(`${verdict.toUpperCase().padEnd(8)} ${action.kind.padEnd(7)} ${why}`);
}
