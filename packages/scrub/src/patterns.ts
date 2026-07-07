/**
 * Secret-shaped pattern table for the scrub gate.
 *
 * Every literal secret-prefix fragment below is built by concatenating two
 * short pieces (e.g. "sk_" + "live_") so that no contiguous secret-shaped
 * string appears anywhere in this source file. This file only ever matches
 * against caller-supplied content — it never itself holds a real secret.
 */

export type Severity = "high" | "medium" | "low";

export interface ScrubPattern {
  name: string;
  severity: Severity;
  /** Returns the matched substring for the first hit on `line`, or null. */
  find(line: string): string | null;
}

function fromRegExp(name: string, severity: Severity, source: string, flags = ""): ScrubPattern {
  const re = new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
  return {
    name,
    severity,
    find(line: string): string | null {
      re.lastIndex = 0;
      const match = re.exec(line);
      return match ? match[0] : null;
    },
  };
}

// --- Stripe ---
const STRIPE_LIVE_SECRET = "sk" + "_live_";
const STRIPE_TEST_SECRET = "sk" + "_test_";
const STRIPE_RESTRICTED_LIVE = "rk" + "_live_";
const STRIPE_RESTRICTED_TEST = "rk" + "_test_";
const STRIPE_WEBHOOK = "wh" + "sec_";

// --- GitHub ---
const GITHUB_CLASSIC_CLASS = "gh" + "[pousr]_"; // ghp_/gho_/ghu_/ghs_/ghr_
const GITHUB_FINE_GRAINED = "github_" + "pat_";

// --- AWS ---
const AWS_ACCESS_KEY = "AK" + "IA";
const AWS_TEMP_ACCESS_KEY = "AS" + "IA";

// --- PEM private keys ---
const PEM_BEGIN = "-----BEGIN " + "[A-Z ]*PRIVATE KEY-----";

// --- JWT header (base64url of `{"`) ---
const JWT_HEADER = "ey" + "J";

export const ALL_PATTERNS: ScrubPattern[] = [
  fromRegExp("stripe live secret key", "high", `\\b${STRIPE_LIVE_SECRET}[A-Za-z0-9]{16,}\\b`),
  fromRegExp("stripe test secret key", "medium", `\\b${STRIPE_TEST_SECRET}[A-Za-z0-9]{16,}\\b`),
  fromRegExp("stripe restricted live key", "high", `\\b${STRIPE_RESTRICTED_LIVE}[A-Za-z0-9]{16,}\\b`),
  fromRegExp("stripe restricted test key", "medium", `\\b${STRIPE_RESTRICTED_TEST}[A-Za-z0-9]{16,}\\b`),
  fromRegExp("stripe webhook secret", "high", `\\b${STRIPE_WEBHOOK}[A-Za-z0-9]{16,}\\b`),

  fromRegExp("github token (classic)", "high", `\\b${GITHUB_CLASSIC_CLASS}[A-Za-z0-9]{20,}\\b`),
  fromRegExp("github token (fine-grained)", "high", `\\b${GITHUB_FINE_GRAINED}[A-Za-z0-9_]{20,}\\b`),

  fromRegExp("aws access key id", "high", `\\b${AWS_ACCESS_KEY}[0-9A-Z]{16}\\b`),
  fromRegExp("aws temporary access key id", "high", `\\b${AWS_TEMP_ACCESS_KEY}[0-9A-Z]{16}\\b`),

  fromRegExp("private key PEM header", "high", PEM_BEGIN),

  fromRegExp("40-char hex id (sha1/git-sha shaped)", "low", `\\b[0-9a-f]{40}\\b`),
  fromRegExp("32-char hex id (md5/uuid-hex shaped)", "low", `\\b[0-9a-f]{32}\\b`),

  fromRegExp("JWT-shaped token", "medium", `\\b${JWT_HEADER}[A-Za-z0-9_-]{6,}\\.${JWT_HEADER}[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{10,}\\b`),

  fromRegExp("bearer token shape", "medium", `\\bBearer\\s+[A-Za-z0-9\\-_.=]{16,}\\b`),

  envAssignmentPattern(),
];

/**
 * Flags `NAME=value` lines (.env style) where the value looks high-entropy —
 * i.e. plausibly a real credential rather than a plain config value. Bare
 * NAME=value lines with low-entropy values (booleans, numbers, URLs, short
 * words) are intentionally left alone to avoid flagging every config line.
 */
function envAssignmentPattern(): ScrubPattern {
  const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(\S+)\s*$/;
  return {
    name: ".env-style NAME=value with high-entropy value",
    severity: "medium",
    find(line: string): string | null {
      const match = assignment.exec(line);
      if (!match) return null;
      const value = match[1];
      if (!looksHighEntropy(value)) return null;
      return line.trim();
    },
  };
}

const LOW_ENTROPY_VALUE = /^(true|false|\d+(\.\d+)?|https?:\/\/\S+|\/[\w./-]*|[\w.-]*\.(com|dev|io|app|net|org))$/i;

function looksHighEntropy(value: string): boolean {
  if (value.length < 12) return false;
  if (LOW_ENTROPY_VALUE.test(value)) return false;
  return shannonEntropyBitsPerChar(value) >= 3.2;
}

function shannonEntropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const len = value.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
