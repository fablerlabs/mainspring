import { readFile } from "node:fs/promises";
import type { GovernanceConfig, Rule } from "./rules.js";
import { createBuiltInRules } from "./rules.js";

export interface ParsedHardRule {
  /** Present only when the line carried a `<!-- rule:ID -->` marker. */
  id?: string;
  text: string;
}

const RULE_ID_COMMENT = /<!--\s*rule:([A-Za-z0-9_-]+)\s*-->/;
const LIST_ITEM = /^\s*(?:\d+\.|[-*])\s+(.*)$/;
const H2_HEADING = /^##[^#]/;

/**
 * Best-effort parser for a CONSTITUTION.md's "## Hard rules" section. Pulls
 * out each list item (joining wrapped continuation lines), and — where a
 * line carries a `<!-- rule:ID -->` marker — records which built-in rule id
 * that prose is describing. Constitutions with no markers still parse fine;
 * they just produce rules with no `id`, which never override a built-in.
 */
export function parseHardRules(markdown: string): ParsedHardRule[] {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^##\s+Hard rules\b/i.test(line.trim()));
  if (startIdx === -1) return [];

  const items: ParsedHardRule[] = [];
  let current: string | null = null;

  const flush = () => {
    if (current === null) return;
    const idMatch = RULE_ID_COMMENT.exec(current);
    const text = current.replace(RULE_ID_COMMENT, "").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      items.push(idMatch ? { id: idMatch[1], text } : { text });
    }
    current = null;
  };

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (H2_HEADING.test(line.trim())) break;

    const listMatch = LIST_ITEM.exec(line);
    if (listMatch) {
      flush();
      current = listMatch[1];
    } else if (line.trim().length === 0) {
      flush();
    } else if (current !== null) {
      current += ` ${line.trim()}`;
    }
  }
  flush();

  return items;
}

/**
 * Attaches human-readable constitution prose to built-in rules by id match.
 * Rules with no matching parsed item keep their built-in description as-is —
 * this is intentionally best-effort, never a hard requirement.
 */
export function attachConstitutionDescriptions(rules: Rule[], parsed: ParsedHardRule[]): Rule[] {
  const byId = new Map<string, string>();
  for (const item of parsed) {
    if (item.id) byId.set(item.id, item.text);
  }
  return rules.map((rule) => {
    const prose = byId.get(rule.id);
    if (!prose) return rule;
    return { ...rule, description: `${rule.description} (constitution: "${prose}")` };
  });
}

export interface LoadedConstitution {
  /** Every hard-rule bullet found, in document order, regardless of id-marker presence. */
  hardRules: ParsedHardRule[];
  /** Built-in rules, with descriptions enriched from any matching id-marked bullets. */
  rules: Rule[];
}

/** Parses `markdown` and builds the enriched built-in rule set in one call. */
export function loadConstitutionRules(markdown: string, config: GovernanceConfig = {}): LoadedConstitution {
  const hardRules = parseHardRules(markdown);
  const rules = attachConstitutionDescriptions(createBuiltInRules(config), hardRules);
  return { hardRules, rules };
}

/** Convenience wrapper: reads a CONSTITUTION.md file off disk, then loads it. */
export async function loadConstitutionFile(path: string, config: GovernanceConfig = {}): Promise<LoadedConstitution> {
  const markdown = await readFile(path, "utf8");
  return loadConstitutionRules(markdown, config);
}
