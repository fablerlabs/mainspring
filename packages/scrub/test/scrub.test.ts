import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_PATTERNS, scan, substitute } from "../src/index.js";

// As in src/patterns.ts: secret-shaped test fixtures are built from
// concatenated fragments so no contiguous secret-shaped literal appears here.
const STRIPE_LIVE_KEY = "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dcREDACTED0";
const STRIPE_TEST_KEY = "sk" + "_test_" + "4eC39HqLyjWDarjtT1zdp7dcREDACTED0";
const STRIPE_RESTRICTED_LIVE = "rk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dcREDACTED0";
const STRIPE_RESTRICTED_TEST = "rk" + "_test_" + "4eC39HqLyjWDarjtT1zdp7dcREDACTED0";
const STRIPE_WEBHOOK = "wh" + "sec_" + "8f3d29a1b4c5d6e7" + "f80912a3b4c5d6e7";
const GITHUB_CLASSIC = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const GITHUB_FINE_GRAINED = "github_" + "pat_" + "11AAAAAAA0aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AWS_ACCESS_KEY = "AK" + "IA" + "IOSFODNN7EXAMPLE";
const AWS_TEMP_KEY = "AS" + "IA" + "IOSFODNN7EXAMPLE";
const PEM_HEADER = "-----BEGIN " + "RSA PRIVATE KEY-----";
const JWT_HEADER = "ey" + "J";
const JWT_TOKEN = `${JWT_HEADER}hbGciOiJIUzI1NiJ9.${JWT_HEADER}zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
const BEARER_TOKEN = "Bearer " + "aVeryLongOpaqueAccessToken1234567890";

function findingsFor(content: string) {
  return scan(content);
}

test("every declared pattern class has at least one true positive fixture", () => {
  const fixtures = [
    STRIPE_LIVE_KEY,
    STRIPE_TEST_KEY,
    STRIPE_RESTRICTED_LIVE,
    STRIPE_RESTRICTED_TEST,
    STRIPE_WEBHOOK,
    GITHUB_CLASSIC,
    GITHUB_FINE_GRAINED,
    AWS_ACCESS_KEY,
    AWS_TEMP_KEY,
    PEM_HEADER,
    "a".repeat(40),
    "b".repeat(32),
    JWT_TOKEN,
    BEARER_TOKEN,
    "API_TOKEN=xK9pL2vQ8wR4zN7mF1sT6yB3",
  ];
  const hitNames = new Set(fixtures.flatMap((line) => findingsFor(line).map((f) => f.pattern)));
  assert.equal(hitNames.size, ALL_PATTERNS.length, `expected every pattern to fire once; got: ${[...hitNames].join(", ")}`);
});

test("stripe live secret key is flagged as high severity", () => {
  const findings = findingsFor(`STRIPE_SECRET_KEY=${STRIPE_LIVE_KEY}`);
  const hit = findings.find((f) => f.pattern === "stripe live secret key");
  assert.ok(hit, "expected a stripe live secret key finding");
  assert.equal(hit?.severity, "high");
});

test("stripe test secret key is flagged as medium severity", () => {
  const findings = findingsFor(`STRIPE_SECRET_KEY=${STRIPE_TEST_KEY}`);
  const hit = findings.find((f) => f.pattern === "stripe test secret key");
  assert.ok(hit);
  assert.equal(hit?.severity, "medium");
});

test("stripe restricted live/test keys are flagged with the right severity", () => {
  const live = findingsFor(`STRIPE_RESTRICTED_KEY=${STRIPE_RESTRICTED_LIVE}`).find((f) => f.pattern === "stripe restricted live key");
  const testKey = findingsFor(`STRIPE_RESTRICTED_KEY=${STRIPE_RESTRICTED_TEST}`).find((f) => f.pattern === "stripe restricted test key");
  assert.equal(live?.severity, "high");
  assert.equal(testKey?.severity, "medium");
});

test("stripe webhook secret is flagged", () => {
  const findings = findingsFor(`STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK}`);
  assert.ok(findings.some((f) => f.pattern === "stripe webhook secret"));
});

test("github classic and fine-grained tokens are flagged", () => {
  assert.ok(findingsFor(GITHUB_CLASSIC).some((f) => f.pattern === "github token (classic)"));
  assert.ok(findingsFor(GITHUB_FINE_GRAINED).some((f) => f.pattern === "github token (fine-grained)"));
});

test("aws access keys are flagged", () => {
  assert.ok(findingsFor(AWS_ACCESS_KEY).some((f) => f.pattern === "aws access key id"));
  assert.ok(findingsFor(AWS_TEMP_KEY).some((f) => f.pattern === "aws temporary access key id"));
});

test("PEM private key header is flagged", () => {
  assert.ok(findingsFor(PEM_HEADER).some((f) => f.pattern === "private key PEM header"));
});

test("40-hex and 32-hex ids are flagged at low severity", () => {
  const hit40 = findingsFor("a".repeat(40)).find((f) => f.pattern.startsWith("40-char hex"));
  const hit32 = findingsFor("b".repeat(32)).find((f) => f.pattern.startsWith("32-char hex"));
  assert.equal(hit40?.severity, "low");
  assert.equal(hit32?.severity, "low");
});

test("JWT-shaped tokens are flagged", () => {
  assert.ok(findingsFor(JWT_TOKEN).some((f) => f.pattern === "JWT-shaped token"));
});

test("bearer token shape is flagged", () => {
  assert.ok(findingsFor(`Authorization: ${BEARER_TOKEN}`).some((f) => f.pattern === "bearer token shape"));
});

test("high-entropy .env-style assignment is flagged, low-entropy config is not", () => {
  const highEntropy = findingsFor("API_TOKEN=xK9pL2vQ8wR4zN7mF1sT6yB3");
  assert.ok(highEntropy.some((f) => f.pattern === ".env-style NAME=value with high-entropy value"));

  const lowEntropy = findingsFor("NODE_ENV=production");
  assert.equal(lowEntropy.length, 0);

  const urlValue = findingsFor("API_BASE_URL=https://api.example.com/v1");
  assert.equal(urlValue.length, 0);
});

test("findings never include the full matched secret in the excerpt", () => {
  const findings = findingsFor(`STRIPE_SECRET_KEY=${STRIPE_LIVE_KEY}`);
  for (const finding of findings) {
    assert.ok(!finding.excerpt.includes(STRIPE_LIVE_KEY), "excerpt must not echo the full match");
  }
});

test("ordinary prose mentioning a key-prefix word is allowed to false-positive (bias to catching)", () => {
  // Documentation that merely *talks about* stripe keys in prose, without an
  // actual key-shaped value, is out of scope for this suite by design.
  const findings = findingsFor("Set your Stripe secret key (starts with sk_live_ or sk_test_) in .env");
  // Not asserting zero findings here — intentionally permissive per the work order.
  assert.ok(Array.isArray(findings));
});

test("line numbers are 1-indexed and correct across multiple lines", () => {
  const content = ["line one is fine", `AWS_KEY=${AWS_ACCESS_KEY}`, "line three is fine"].join("\n");
  const findings = findingsFor(content);
  const hit = findings.find((f) => f.pattern === "aws access key id");
  assert.equal(hit?.line, 2);
});

test("substitute replaces exact env values with <NAME> placeholders", () => {
  const envMap = {
    STRIPE_SECRET_KEY: STRIPE_LIVE_KEY,
    GITHUB_TOKEN: GITHUB_CLASSIC,
  };
  const content = `key=${STRIPE_LIVE_KEY}\ntoken=${GITHUB_CLASSIC}\nother=unchanged`;
  const result = substitute(content, envMap);
  assert.equal(result, "key=<STRIPE_SECRET_KEY>\ntoken=<GITHUB_TOKEN>\nother=unchanged");
  assert.ok(!result.includes(STRIPE_LIVE_KEY));
  assert.ok(!result.includes(GITHUB_CLASSIC));
});

test("substitute replaces longer values first to avoid partial-overlap corruption", () => {
  const envMap = { SHORT: "abc", LONG: "abcdef" };
  const result = substitute("value=abcdef", envMap);
  assert.equal(result, "value=<LONG>");
});

test("substitute ignores empty-string env values", () => {
  const result = substitute("FOO=bar", { EMPTY: "" });
  assert.equal(result, "FOO=bar");
});
