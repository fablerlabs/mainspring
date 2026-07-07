# @mainspring/scrub API

The scrub gate: detects secret-shaped strings in content before any publish
or notify action, and can substitute known env values with `<NAME>`
placeholders so redacted content stays safe to write to a public
destination. Zero runtime dependencies, no network I/O — every pattern is a
plain regex or local entropy check run against in-memory strings or files
read from disk.

## Exports

### `patterns.ts` — `ALL_PATTERNS`, `ScrubPattern`, `Severity`

```ts
type Severity = "high" | "medium" | "low";

interface ScrubPattern {
  name: string;
  severity: Severity;
  find(line: string): string | null; // matched substring for the first hit on `line`, or null
}

const ALL_PATTERNS: ScrubPattern[];
```

`ALL_PATTERNS` is the default, fixed-order pattern set (15 entries) used by
`scan`/`scanFiles` unless overridden via `ScanOptions.patterns`. Each entry's
`find(line)` re-runs its regex from `lastIndex = 0` on a single line and
returns only the first match on that line (a line with two hits of the same
pattern only reports once).

| name | severity | matches |
| --- | --- | --- |
| `stripe live secret key` | high | `sk_live_` + 16+ alphanumeric chars |
| `stripe test secret key` | medium | `sk_test_` + 16+ alphanumeric chars |
| `stripe restricted live key` | high | `rk_live_` + 16+ alphanumeric chars |
| `stripe restricted test key` | medium | `rk_test_` + 16+ alphanumeric chars |
| `stripe webhook secret` | high | `whsec_` + 16+ alphanumeric chars |
| `github token (classic)` | high | `gh` + one of `p`/`o`/`u`/`s`/`r` + `_` (i.e. `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`) + 20+ alphanumeric chars |
| `github token (fine-grained)` | high | `github_pat_` + 20+ chars of `[A-Za-z0-9_]` |
| `aws access key id` | high | `AKIA` + 16 chars of `[0-9A-Z]` |
| `aws temporary access key id` | high | `ASIA` + 16 chars of `[0-9A-Z]` |
| `private key PEM header` | high | `-----BEGIN <ANYTHING-UPPER-OR-SPACE>PRIVATE KEY-----` (matches `RSA PRIVATE KEY`, `EC PRIVATE KEY`, `PRIVATE KEY`, etc.) |
| `40-char hex id (sha1/git-sha shaped)` | low | a bare 40-hex-digit token (word-bounded) — shaped like a git SHA or SHA-1 digest |
| `32-char hex id (md5/uuid-hex shaped)` | low | a bare 32-hex-digit token (word-bounded) — shaped like an MD5 digest or a dash-free UUID |
| `JWT-shaped token` | medium | two base64url segments each starting with `eyJ` (a JWT's base64url-encoded `{"` header prefix), joined by `.`, followed by a third `.`-separated segment (the signature) |
| `bearer token shape` | medium | `Bearer ` followed by 16+ chars of `[A-Za-z0-9\-_.=]` |
| `.env-style NAME=value with high-entropy value` | medium | see below |

The `.env`-style pattern is not a plain regex: it matches lines of the shape
`NAME=value` (optional leading/trailing whitespace, `NAME` a valid
identifier), then only flags the line if `value` "looks high-entropy":
length ≥ 12, not matching a low-entropy allowlist regex (booleans, plain
numbers, `http(s)://` URLs, absolute paths, or bare domains ending in a
handful of common TLDs), and Shannon entropy ≥ 3.2 bits/char. This is a
deliberate false-negative/false-positive tradeoff to avoid flagging every
`NODE_ENV=production`-style config line while still catching arbitrary
random-looking credential values that don't match any of the branded
patterns above.

Two secret-shaped patterns from real-world use are notably absent from
`ALL_PATTERNS`: there is no generic OpenAI/Anthropic/etc. vendor-key
pattern, and no generic "long base64 blob" catch-all beyond the JWT and hex
shapes — those categories rely entirely on the entropy-based `.env`
pattern or the bearer-token pattern to be caught.

Every literal secret prefix in `patterns.ts` (e.g. `sk_live_`, `ghp_`,
`AKIA`) is built by string-concatenating two short fragments so that no
contiguous secret-shaped literal appears in the source file itself — this
file only ever matches against caller-supplied content.

### `scan.ts` — `scan`, `scanFiles`, `Finding`, `ScanOptions`

```ts
interface Finding {
  file?: string;      // present only for scanFiles() results; absent for scan(content)
  line: number;        // 1-indexed line number within the scanned content
  pattern: string;      // the ScrubPattern.name that matched
  severity: Severity;
  excerpt: string;      // redacted excerpt of the match — never the full matched string
}

interface ScanOptions {
  patterns?: ScrubPattern[]; // override the pattern set; defaults to ALL_PATTERNS
}

function scan(content: string, opts?: ScanOptions): Finding[];
function scanFiles(paths: string[], opts?: ScanOptions): Promise<Finding[]>;
```

`scan(content, opts)` splits `content` on `\r?\n`, runs every pattern in
`opts.patterns ?? ALL_PATTERNS` against each line, and returns one `Finding`
per match (a single line can produce multiple findings if several patterns
or the same pattern's first-hit rule fire). Findings are returned in
line-then-pattern-array order; `file` is omitted.

`scanFiles(paths, opts)` reads each path in `paths` with
`readFile(path, "utf8")`, calls `scan` on its contents, and re-emits each
resulting `Finding` with `file` set to that path. It does not expand globs
or directories itself — callers must already have resolved `paths` to a
list of concrete file paths (the README example passes literal filenames).
Reading as UTF-8 means non-UTF-8/binary files are not specially detected or
skipped; they are decoded (potentially lossily) and scanned as text.
Symlinks are followed transparently since `readFile` follows the OS's
normal symlink resolution — there is no explicit handling either way.

The `excerpt` field is produced by a local `redact()` helper: matches of 8
characters or fewer become all asterisks; longer matches keep their first 4
and last 4 characters and mask everything in between with asterisks (with
the masked run padded to a minimum of 4 asterisks). This guarantees the full
matched secret is never present in a `Finding`, so findings are safe to log
or print directly.

### `placeholders.ts` — `substitute`

```ts
function substitute(content: string, envMap: Record<string, string>): string;
```

Replaces every literal occurrence of each value in `envMap` with a
`<NAME>` placeholder (the map key, wrapped in angle brackets), doing a
plain substring `split`/`join` (not regex) so no character in the secret
value needs escaping. Entries with an empty-string value are skipped
entirely (never substituted, and never a match-everything hazard). Before
substituting, entries are sorted by value length descending, so that if one
value happens to be a substring of another (e.g. a short id embedded inside
a longer token), the longer/containing value is replaced first and the
shorter one doesn't fragment it. `substitute` does not consult
`ALL_PATTERNS` at all — it only ever matches exact, caller-supplied values,
making it the mechanism used to scrub a specific set of known env values
out of content headed for a public destination (e.g. this package's own
`brain-publish.sh`-style workflow).

## Example

```ts
import { scan, substitute } from "@mainspring/scrub";

const content = `STRIPE_SECRET_KEY=${process.env.STRIPE_SECRET_KEY}`;

const findings = scan(content);
// findings[0] => {
//   line: 1,
//   pattern: "stripe live secret key",
//   severity: "high",
//   excerpt: "sk_l***************dp7c", // full key never appears
// }

const redacted = substitute(content, {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
});
// redacted === "STRIPE_SECRET_KEY=<STRIPE_SECRET_KEY>"
```
