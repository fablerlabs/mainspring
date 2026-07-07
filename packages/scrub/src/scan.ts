import { readFile } from "node:fs/promises";
import { ALL_PATTERNS, type ScrubPattern, type Severity } from "./patterns.js";

export interface Finding {
  /** File path, when scanning via scanFiles; absent for scan(content). */
  file?: string;
  line: number;
  pattern: string;
  severity: Severity;
  /** Redacted excerpt of the match — the full match is never included. */
  excerpt: string;
}

export interface ScanOptions {
  /** Override the pattern set to scan with. Defaults to ALL_PATTERNS. */
  patterns?: ScrubPattern[];
}

/** Never returns the full matched string, even for a caller that logs excerpts. */
function redact(match: string): string {
  if (match.length <= 8) return "*".repeat(match.length);
  const keep = 4;
  const masked = "*".repeat(Math.max(match.length - keep * 2, 4));
  return `${match.slice(0, keep)}${masked}${match.slice(-keep)}`;
}

/**
 * Zero-width/format characters (ZWSP, ZWNJ, ZWJ, word joiner, bidi overrides,
 * BOM, soft hyphen) have no visible glyph but split a contiguous secret
 * literal for regex purposes — "sk_live_" + ZWSP + "4eC39..." reads identically
 * to a human but no longer matches a `[A-Za-z0-9]{16,}` run. Strip them before
 * matching so this can't be used to smuggle a secret past a shape check.
 */
const INVISIBLE_CHARS = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]",
  "g",
);

export function scan(content: string, opts: ScanOptions = {}): Finding[] {
  const patterns = opts.patterns ?? ALL_PATTERNS;
  const findings: Finding[] = [];
  const lines = content.replace(INVISIBLE_CHARS, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      const match = pattern.find(line);
      if (match !== null) {
        findings.push({
          line: i + 1,
          pattern: pattern.name,
          severity: pattern.severity,
          excerpt: redact(match),
        });
      }
    }
  }
  return findings;
}

export async function scanFiles(paths: string[], opts: ScanOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const path of paths) {
    const content = await readFile(path, "utf8");
    for (const finding of scan(content, opts)) {
      findings.push({ ...finding, file: path });
    }
  }
  return findings;
}
