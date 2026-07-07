#!/usr/bin/env node
/**
 * mainspring soak harness.
 *
 * Drives the REAL @mainspring/core session loop (assemble -> brain.step ->
 * gate -> dispatch -> commit, via the exported `runSession`) for many
 * hundreds/thousands of simulated sessions against a throwaway git repo in
 * the OS temp dir, with a deterministic scripted Brain (no network, no API
 * key, seeded PRNG). It measures how the workspace behaves over a long
 * horizon: file growth, STATE.md compaction effectiveness (via the real
 * @mainspring/memory compactState), gate-block reasons, wall time trend, and
 * crash/resume robustness.
 *
 * Usage:
 *   node tools/soak.mjs [--sessions 1000] [--seed 42] [--out path.json] [--keep]
 *
 * Requires the workspace to already be built (`pnpm -r build`) — this script
 * imports the compiled dist/ output of @mainspring/core and @mainspring/memory
 * directly, the same artifacts `mainspring run` uses.
 *
 * See docs/soak-testing.md for what the numbers mean.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIST = join(HERE, "..", "packages", "core", "dist", "index.js");
const MEMORY_DIST = join(HERE, "..", "packages", "memory", "dist", "index.js");

for (const [label, path] of [["@mainspring/core", CORE_DIST], ["@mainspring/memory", MEMORY_DIST]]) {
  if (!existsSync(path)) {
    console.error(`soak: cannot find built ${label} at ${path}`);
    console.error(`soak: run "pnpm -r build" from the mainspring/ workspace root first.`);
    process.exit(1);
  }
}

const { runSession } = await import(CORE_DIST);
const { compactState } = await import(MEMORY_DIST);

// ---------------------------------------------------------------- args ---

function parseArgs(argv) {
  const out = { sessions: 1000, seed: 42, out: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inlineVal = eq === -1 ? null : arg.slice(eq + 1);
    const takeVal = () => (inlineVal !== null ? inlineVal : argv[++i]);
    switch (key) {
      case "--sessions":
        out.sessions = Number(takeVal());
        break;
      case "--seed":
        out.seed = Number(takeVal());
        break;
      case "--out":
        out.out = takeVal();
        break;
      case "--keep":
        out.keep = true;
        break;
      default:
        console.error(`soak: unknown argument "${arg}"`);
        process.exit(1);
    }
  }
  if (!Number.isFinite(out.sessions) || out.sessions <= 0) {
    console.error("soak: --sessions must be a positive number");
    process.exit(1);
  }
  if (!Number.isFinite(out.seed)) {
    console.error("soak: --seed must be a number");
    process.exit(1);
  }
  return out;
}

// ------------------------------------------------------------- seeded RNG ---

/** mulberry32 — small, fast, deterministic PRNG. Same seed => same sequence, always. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chance(rng, p) {
  return rng() < p;
}

function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pickWeighted(rng, entries) {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let x = rng() * total;
  for (const [value, w] of entries) {
    if (x < w) return value;
    x -= w;
  }
  return entries[entries.length - 1][0];
}

// -------------------------------------------------------- fake wall clock ---

// The scripted brain proposes actions "on a timer" over months of simulated
// business time, but the whole soak has to finish in real seconds. Rather
// than fabricate timestamps by hand (which the loop doesn't accept as input
// anyway — assemble.ts and loop.ts both call `new Date()` directly), patch
// the global Date constructor for the process. This is the standard
// fake-timers trick; it's local to this script's process and never touches
// the real system clock or any other process.
const RealDate = Date;
let fakeNowMs = RealDate.now();

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(fakeNowMs);
    } else {
      super(...args);
    }
  }
  static now() {
    return fakeNowMs;
  }
}
globalThis.Date = FakeDate;

function advanceClock(ms) {
  fakeNowMs += ms;
}

// ------------------------------------------------------- content builders ---

const WORD_BANK = [
  "shipped", "drafted", "reviewed", "priced", "queued", "notified", "renewed",
  "audited", "compacted", "archived", "onboarded", "throttled", "escalated",
  "landing", "checkout", "waitlist", "funnel", "distribution", "ledger",
  "constitution", "relay", "governance", "gate", "workspace", "backlog",
  "product", "customer", "refund", "invoice", "domain", "subscription",
];

function randomPhrase(rng, minWords, maxWords) {
  const n = intBetween(rng, minWords, maxWords);
  const words = [];
  for (let i = 0; i < n; i++) words.push(WORD_BANK[intBetween(rng, 0, WORD_BANK.length - 1)]);
  return words.join(" ");
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Mirrors @mainspring/memory's journal.ts append format, without touching disk directly —
 * the result becomes the content of a gated `write` Action instead. */
function appendJournalText(existingTail, date, note) {
  const block = ensureTrailingNewline(`- ${new Date().toISOString()} ${note}`);
  if (!existingTail) {
    return `# Journal — ${date}\n\n${block}`;
  }
  const separator = existingTail.endsWith("\n") ? "\n" : "\n\n";
  return `${existingTail}${separator}${block}`;
}

function initialStateMd(seed) {
  return [
    `# STATE — Soak Co (seed ${seed})`,
    "",
    "Synthetic workspace generated by mainspring/tools/soak.mjs. Nothing here",
    "is a real business; it exists only to grow STATE.md, journal/, and",
    "LEDGER.csv across many simulated sessions so the loop's long-horizon",
    "behavior can be measured honestly.",
    "",
    "## Status",
    "",
    "Soak test running.",
    "",
    "## Next up",
    "",
    "- (updated every session)",
    "",
    "## Open questions / blockers",
    "",
    "- (none)",
    "",
    "## Session log",
    "",
  ].join("\n");
}

function appendStateEntry(currentState, sessionIndex, rng) {
  const base = currentState && currentState.trim().length > 0 ? currentState : initialStateMd("unknown");
  const bulletCount = intBetween(rng, 1, 3);
  const bullets = [];
  for (let i = 0; i < bulletCount; i++) bullets.push(`- ${randomPhrase(rng, 3, 9)}`);
  const withNl = ensureTrailingNewline(base);
  const entry = `\n### session ${sessionIndex} — ${new Date().toISOString()}\n${bullets.join("\n")}\n`;
  return `${withNl}${entry}`;
}

// ----------------------------------------------------------- action makers ---

const TOOLS = [
  {
    name: "noop.ping",
    description: "soak-test no-op tool; exercises the run/dispatch path with no external effect",
    argsSchema: { type: "object" },
  },
];

function ledgerAction(rng, type, amountUsd) {
  return {
    kind: "ledger",
    entry: {
      date: new Date().toISOString(),
      type,
      description: `soak ${type}: ${randomPhrase(rng, 2, 5)}`,
      amountUsd,
    },
  };
}

function enqueueAction(rng, sessionIndex) {
  return {
    kind: "enqueue",
    order: {
      id: `soak-wo-${sessionIndex}-${intBetween(rng, 1000, 9999)}`,
      title: randomPhrase(rng, 2, 6),
      body: randomPhrase(rng, 5, 20),
      createdAt: new Date().toISOString(),
    },
  };
}

function relayAction(rng, sessionIndex) {
  return {
    kind: "relay",
    request: {
      id: `soak-relay-${sessionIndex}-${intBetween(rng, 1000, 9999)}`,
      summary: randomPhrase(rng, 2, 6),
      detail: randomPhrase(rng, 5, 15),
      estimateMinutes: intBetween(rng, 2, 15),
      createdAt: new Date().toISOString(),
    },
  };
}

function notifyAction(rng) {
  return { kind: "notify", to: "owner", text: `soak update: ${randomPhrase(rng, 3, 10)}` };
}

/** Actions specific to a probe "mode" — the mix of allowed/blocked/malformed
 * actions the work order asks for. Each mode is chosen to land in exactly
 * one gate.ts decision branch, so the soak's blocked-reason buckets map 1:1
 * onto real gate code paths rather than being guessed at. */
function modeActions(mode, rng, cfg) {
  switch (mode) {
    case "normal": {
      const acts = [];
      if (chance(rng, 0.5)) acts.push(ledgerAction(rng, "revenue", Math.round(rng() * 40 * 100) / 100));
      if (chance(rng, 0.3)) acts.push(ledgerAction(rng, "expense", Math.round(rng() * 6 * 100) / 100));
      if (chance(rng, 0.15)) acts.push(enqueueAction(rng, cfg.sessionIndex));
      if (chance(rng, 0.08)) acts.push(relayAction(rng, cfg.sessionIndex));
      if (chance(rng, 0.06)) acts.push(notifyAction(rng));
      if (chance(rng, 0.2)) acts.push({ kind: "run", tool: TOOLS[0].name, args: { seq: cfg.sessionIndex } });
      return acts;
    }
    case "ledger-cap-block":
      return [ledgerAction(rng, "expense", cfg.constitution.moneyCaps.perSessionUsd + 10)];
    case "ledger-negative":
      return [ledgerAction(rng, "expense", -5)];
    case "ledger-nonfinite":
      return [ledgerAction(rng, "expense", chance(rng, 0.5) ? Number.NaN : Number.POSITIVE_INFINITY)];
    case "path-escape":
      return [{ kind: "write", path: "../../etc/soak-escape.txt", content: "should never land outside the workspace" }];
    case "forbidden-target":
      return [{ kind: "write", path: chance(rng, 0.5) ? ".env" : ".git/config", content: "PWNED=1" }];
    case "secret-write":
      return [{ kind: "write", path: "notes/leak.md", content: `OPENAI_API_KEY=sk-${"x".repeat(32)}` }];
    case "secret-notify":
      return [{ kind: "notify", to: "owner", text: `leaked AWS_SECRET_ACCESS_KEY=${"a".repeat(24)}` }];
    case "unknown-tool":
      return [{ kind: "run", tool: "definitely-not-registered", args: {} }];
    case "unknown-kind":
      // Deliberately not a member of the Action union. gate.ts is TS-typed at
      // compile time only; this checks its runtime `default` branch actually
      // fails safe (block, no throw) instead of assuming the exhaustiveness
      // check protects anything at runtime.
      return [{ kind: "self-destruct", payload: rng() }];
    default:
      return [];
  }
}

const MODE_WEIGHTS = [
  ["normal", 60],
  ["ledger-cap-block", 7],
  ["ledger-negative", 5],
  ["ledger-nonfinite", 5],
  ["path-escape", 5],
  ["forbidden-target", 5],
  ["secret-write", 5],
  ["secret-notify", 4],
  ["unknown-tool", 5],
  ["unknown-kind", 3],
];

// ------------------------------------------------------------- the brain ---

class SoakBrain {
  id = "soak-scripted";
  model = "soak-deterministic-v1";

  constructor(rng, constitution, metrics, stateMaxLines) {
    this.rng = rng;
    this.constitution = constitution;
    this.metrics = metrics;
    this.stateMaxLines = stateMaxLines;
    this.sessionIndex = 0;
    this.stepIndex = 0;
    this.stepsPlanned = 1;
  }

  beginSession(sessionIndex) {
    this.sessionIndex = sessionIndex;
    this.stepIndex = 0;
    this.stepsPlanned = chance(this.rng, 0.25) ? 2 : 1;
  }

  async step(input, _history) {
    this.stepIndex += 1;
    const isFirst = this.stepIndex === 1;
    const isLast = this.stepIndex === this.stepsPlanned;
    const actions = [];

    if (isFirst) {
      const today = new Date().toISOString().slice(0, 10);
      actions.push({
        kind: "write",
        path: `journal/${today}.md`,
        content: appendJournalText(input.journalTail, today, `session ${this.sessionIndex}: ${randomPhrase(this.rng, 4, 14)}`),
      });

      const rawState = appendStateEntry(input.state, this.sessionIndex, this.rng);
      const rawBytes = Buffer.byteLength(rawState, "utf8");
      if (this.metrics.compaction.entryByteSamples.length < 40) {
        // Sample early (pre-compaction) entry sizes to later estimate what
        // STATE.md *would* have grown to with no compaction at all.
        const prevBytes = input.state ? Buffer.byteLength(input.state, "utf8") : 0;
        this.metrics.compaction.entryByteSamples.push(rawBytes - prevBytes);
      }
      const { content: compacted, dropped } = compactState(rawState, this.stateMaxLines);
      if (dropped > 0) {
        this.metrics.compaction.timesTriggered += 1;
        this.metrics.compaction.totalEntriesDropped += dropped;
      }
      actions.push({ kind: "write", path: "STATE.md", content: compacted });
    }

    if (isFirst && !isLast) {
      if (chance(this.rng, 0.4)) actions.push(ledgerAction(this.rng, "revenue", Math.round(this.rng() * 10 * 100) / 100));
      if (chance(this.rng, 0.2)) actions.push(enqueueAction(this.rng, this.sessionIndex));
    }

    if (isLast) {
      const mode = pickWeighted(this.rng, MODE_WEIGHTS);
      this.metrics.modes[mode] = (this.metrics.modes[mode] ?? 0) + 1;
      actions.push(...modeActions(mode, this.rng, { constitution: this.constitution, sessionIndex: this.sessionIndex }));
      actions.push({ kind: "done" });
    }

    return { actions, usage: { inputTokens: 0, outputTokens: 0, wallMs: 0 }, done: isLast };
  }
}

// ---------------------------------------------------------- fs/git helpers ---

async function dirBytes(root) {
  let total = 0;
  let names;
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of names) {
    if (entry.name === ".git" || entry.name === ".mainspring") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // file vanished between readdir and stat (e.g. concurrent write in a real
        // deployment) — skip it rather than fail the whole size sample.
      }
    }
  }
  return total;
}

async function fileBytes(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * True if the workspace has no uncommitted changes, EXCEPT for
 * `.mainspring/last-session.json` — a pre-existing (soak-discovered, see
 * docs/soak-testing.md) quirk in loop.ts writes that audit file *after* the
 * git commit, so it trails one commit behind on every session, crash or not.
 * It has no reader anywhere in the codebase today, so this doesn't indicate
 * a real recovery failure; excluding it here keeps the crash/resume metric
 * honest about what a crash actually breaks.
 */
async function isGitClean(workspaceDir) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspaceDir });
  const meaningful = stdout.split("\n").filter((line) => line.trim().length > 0 && !line.includes(".mainspring/last-session.json"));
  return meaningful.length === 0;
}

async function initGitRepo(workspaceDir, seed) {
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceDir });
  await execFileAsync("git", ["config", "user.email", "soak@mainspring.local"], { cwd: workspaceDir });
  await execFileAsync("git", ["config", "user.name", "Mainspring Soak"], { cwd: workspaceDir });
  await writeFile(join(workspaceDir, "STATE.md"), initialStateMd(seed), "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: workspaceDir });
  await execFileAsync("git", ["commit", "-q", "-m", "soak: init workspace"], { cwd: workspaceDir });
}

/** Simulates a torn write: an OS-level crash mid-fsync truncates the tail of
 * whichever file was most recently written. Targets LEDGER.csv when it has
 * enough bytes to survive a meaningful cut; STATE.md otherwise (it always
 * exists once the first session has run). */
async function simulateTornWrite(workspaceDir, rng) {
  const ledgerPath = join(workspaceDir, "LEDGER.csv");
  const statePath = join(workspaceDir, "STATE.md");
  const ledgerSize = await fileBytes(ledgerPath);
  const target = ledgerSize > 60 ? ledgerPath : statePath;
  const buf = await readFile(target);
  const maxCut = Math.max(1, Math.min(30, buf.length - 20));
  const cut = intBetween(rng, 1, maxCut);
  await writeFile(target, buf.subarray(0, buf.length - cut));
  return { target: target === ledgerPath ? "LEDGER.csv" : "STATE.md", cutBytes: cut };
}

// -------------------------------------------------------- reason bucketing ---

function classifyReason(reason) {
  if (/finite number/.test(reason)) return "ledger-non-finite-amount";
  if (/must be non-negative/.test(reason)) return "ledger-negative-amount";
  if (/exceeding the per-session cap/.test(reason)) return "ledger-exceeds-session-cap";
  if (/escapes workspace/.test(reason)) return "write-path-escape";
  if (/forbidden file/.test(reason)) return "write-forbidden-target";
  if (/write content matches a secret-like pattern/.test(reason)) return "write-secret-like-content";
  if (/notify text matches a secret-like pattern/.test(reason)) return "notify-secret-like-content";
  if (/not in the workspace's allowed tool list/.test(reason)) return "run-unknown-tool";
  if (/unknown action kind/.test(reason)) return "unknown-action-kind";
  return `other: ${reason.slice(0, 60)}`;
}

// ------------------------------------------------------------------- main ---

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rng = mulberry32(args.seed);

  const constitution = {
    name: "Soak Co",
    mission: "Synthetic business used only to soak-test the mainspring session loop.",
    hardRules: [
      "Legal and honest only.",
      "This is an AI-run operation and must never claim otherwise.",
      "Secrets never appear in a file, ledger entry, or notification.",
    ],
    moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
    maxSessionMs: 40 * 60 * 1000,
  };

  const STATE_MAX_LINES = 220;
  const CRASH_PROB = 0.025;

  const metrics = {
    modes: {},
    gateBlocksByReason: {},
    compaction: { timesTriggered: 0, totalEntriesDropped: 0, entryByteSamples: [] },
    crash: { attempted: 0, resumedOk: 0, failures: [], tornSamples: [] },
    sizeSamples: [],
    wallMsSamples: [],
    totals: {
      sessionsCompleted: 0,
      actionsProposed: 0,
      actionsAllowed: 0,
      actionsBlocked: 0,
      simulatedSpentUsd: 0,
    },
    fatalErrors: [],
  };

  const workspaceDir = await mkdtemp(join(tmpdir(), "mainspring-soak-"));
  console.log(`soak: workspace ${workspaceDir}`);
  console.log(`soak: sessions=${args.sessions} seed=${args.seed}`);

  const startedAt = new RealDate().toISOString();
  const wallStart = performance.now();
  let wallMsWindow = [];
  let forceNoCrash = false;
  let pendingCrashVerification = false;

  try {
    await initGitRepo(workspaceDir, args.seed);
    const brain = new SoakBrain(rng, constitution, metrics, STATE_MAX_LINES);

    // Session 0 size sample, before any session has run.
    metrics.sizeSamples.push({ atSession: 0, totalBytes: await dirBytes(workspaceDir) });

    for (let i = 1; i <= args.sessions; i++) {
      brain.beginSession(i);
      const isCrash = !forceNoCrash && chance(rng, CRASH_PROB);
      forceNoCrash = false;

      const t0 = performance.now();
      let summary;
      let threw = false;
      try {
        summary = await runSession({
          workspaceDir,
          constitution,
          brain,
          tools: TOOLS,
          commit: !isCrash,
        });
      } catch (err) {
        threw = true;
        metrics.fatalErrors.push({ session: i, error: String(err && err.stack ? err.stack : err) });
      }
      const wallMs = performance.now() - t0;
      wallMsWindow.push(wallMs);

      if (summary) {
        metrics.totals.sessionsCompleted += 1;
        metrics.totals.actionsProposed += summary.actionsProposed;
        metrics.totals.actionsAllowed += summary.actionsAllowed;
        metrics.totals.actionsBlocked += summary.actionsBlocked;
        metrics.totals.simulatedSpentUsd += summary.spentUsd;
        for (const reason of summary.blockedReasons) {
          const bucket = classifyReason(reason);
          metrics.gateBlocksByReason[bucket] = (metrics.gateBlocksByReason[bucket] ?? 0) + 1;
        }
      }

      if (pendingCrashVerification) {
        pendingCrashVerification = false;
        const clean = !threw && (await isGitClean(workspaceDir));
        if (clean) {
          metrics.crash.resumedOk += 1;
        } else {
          metrics.crash.failures.push({ afterSession: i, threw, cleanTree: clean });
        }
      }

      if (isCrash) {
        metrics.crash.attempted += 1;
        const torn = await simulateTornWrite(workspaceDir, rng);
        metrics.crash.tornSamples.push({ session: i, ...torn });
        pendingCrashVerification = true;
        forceNoCrash = true; // never stack two crashes back to back — one clean resume at a time
      }

      // ~4-10h of simulated business time between wake-ups (a few sessions/day).
      advanceClock(intBetween(rng, 4, 10) * 60 * 60 * 1000);

      if (i % 50 === 0 || i === args.sessions) {
        const totalBytes = await dirBytes(workspaceDir);
        const stateBytes = await fileBytes(join(workspaceDir, "STATE.md"));
        const ledgerBytes = await fileBytes(join(workspaceDir, "LEDGER.csv"));
        metrics.sizeSamples.push({ atSession: i, totalBytes, stateBytes, ledgerBytes });
        const windowSize = wallMsWindow.length;
        const avgMs = wallMsWindow.reduce((a, b) => a + b, 0) / windowSize;
        metrics.wallMsSamples.push({ atSession: i, windowSize, avgMsLastWindow: Math.round(avgMs * 100) / 100 });
        wallMsWindow = [];
        console.log(
          `soak: session ${i}/${args.sessions} — total ${(totalBytes / 1024).toFixed(1)}KB, ` +
            `avg ${avgMs.toFixed(1)}ms/session (last ${windowSize}), crashes tested ${metrics.crash.attempted}`,
        );
      }
    }

    if (pendingCrashVerification) {
      // The last session happened to be the crash test; there's no following
      // session to resume into within this run, so it's unverified rather
      // than failed — don't count it either way.
      metrics.crash.attempted -= 1;
    }
  } finally {
    if (!args.keep) {
      await rm(workspaceDir, { recursive: true, force: true });
    } else {
      console.log(`soak: --keep set, workspace left at ${workspaceDir}`);
    }
  }

  const endedAt = new RealDate().toISOString();
  const wallTotalMs = performance.now() - wallStart;

  const first = metrics.wallMsSamples[0];
  const last = metrics.wallMsSamples[metrics.wallMsSamples.length - 1];
  const wallTrendPct =
    first && last && first.avgMsLastWindow > 0
      ? Math.round(((last.avgMsLastWindow - first.avgMsLastWindow) / first.avgMsLastWindow) * 10000) / 100
      : null;

  const avgEntryBytes =
    metrics.compaction.entryByteSamples.length > 0
      ? metrics.compaction.entryByteSamples.reduce((a, b) => a + b, 0) / metrics.compaction.entryByteSamples.length
      : 0;
  const headBytes = Buffer.byteLength(initialStateMd(args.seed), "utf8");
  const estimatedUncompactedStateBytes = Math.round(headBytes + avgEntryBytes * args.sessions);
  const actualFinalStateBytes = metrics.sizeSamples[metrics.sizeSamples.length - 1]?.stateBytes ?? 0;

  const report = {
    tool: "mainspring/tools/soak.mjs",
    args: { sessions: args.sessions, seed: args.seed },
    startedAt,
    endedAt,
    wallTotalMs: Math.round(wallTotalMs),
    machine: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      totalMemGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    },
    totals: metrics.totals,
    modes: metrics.modes,
    gateBlocksByReason: metrics.gateBlocksByReason,
    compaction: {
      timesTriggered: metrics.compaction.timesTriggered,
      totalEntriesDropped: metrics.compaction.totalEntriesDropped,
      stateMaxLines: STATE_MAX_LINES,
      actualFinalStateBytes,
      estimatedUncompactedStateBytes,
      bytesSavedEstimate: Math.max(0, estimatedUncompactedStateBytes - actualFinalStateBytes),
    },
    crash: {
      probabilityPerSession: CRASH_PROB,
      attempted: metrics.crash.attempted,
      resumedOk: metrics.crash.resumedOk,
      failures: metrics.crash.failures,
      tornWriteSamples: metrics.crash.tornSamples.slice(0, 20),
    },
    sizeSamples: metrics.sizeSamples,
    wallMsSamples: metrics.wallMsSamples,
    wallTimeTrendPct: wallTrendPct,
    fatalErrors: metrics.fatalErrors,
  };

  const outPath = args.out ?? join(HERE, ".soak-reports", `report-s${args.sessions}-seed${args.seed}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  console.log("=== soak summary ===");
  console.log(`sessions completed: ${metrics.totals.sessionsCompleted}/${args.sessions}`);
  console.log(`actions: ${metrics.totals.actionsProposed} proposed, ${metrics.totals.actionsAllowed} allowed, ${metrics.totals.actionsBlocked} blocked`);
  console.log(`gate blocks by reason:`);
  for (const [reason, count] of Object.entries(metrics.gateBlocksByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log(`crash/resume: ${metrics.crash.resumedOk}/${metrics.crash.attempted} clean resumes`);
  if (metrics.crash.failures.length > 0) {
    console.log(`  FAILURES: ${JSON.stringify(metrics.crash.failures)}`);
  }
  console.log(
    `STATE.md compaction: triggered ${metrics.compaction.timesTriggered}x, dropped ${metrics.compaction.totalEntriesDropped} entries total, ` +
      `final ${actualFinalStateBytes}B vs. estimated ${estimatedUncompactedStateBytes}B with no compaction`,
  );
  console.log(`wall time trend: ${wallTrendPct === null ? "n/a" : `${wallTrendPct}%`} (first window avg -> last window avg, ms/session)`);
  if (metrics.fatalErrors.length > 0) {
    console.log(`FATAL ERRORS (${metrics.fatalErrors.length}):`);
    for (const e of metrics.fatalErrors) console.log(`  session ${e.session}: ${e.error}`);
  }
  console.log(`wall clock for this whole soak run: ${(wallTotalMs / 1000).toFixed(1)}s`);
  console.log(`full report: ${outPath}`);

  globalThis.Date = RealDate;
  process.exitCode = metrics.fatalErrors.length > 0 ? 1 : 0;
}

main().catch((err) => {
  globalThis.Date = RealDate;
  console.error("soak: fatal error", err);
  process.exitCode = 1;
});
