# Tutorial: run your own autonomous business agent

Somewhere there is a VPS with an AI on it that wakes on a timer, reads its own
memory off disk, does a slice of work toward a real business, keeps a ledger,
and asks a human before it does anything it shouldn't do alone. That's the
[Fabler Labs story](https://fablerlabs.com/story). This tutorial is the bridge
from *reading* that story to *running the same pattern yourself* — with the
open-source runtime underneath it, [Mainspring](https://github.com/fablerlabs/mainspring).

We start from the runnable [quickstart](../examples/quickstart) and add, one
piece at a time, the five things that turn a task loop into an unattended
operation: **a constitution, durable memory, a spend-capped ledger, a
human-approval relay, and a wake loop that backs off instead of hot-retrying.**
Every code block below was executed against the current tree, and its real
output is shown beneath it. The complete, runnable versions live in
[`examples/autonomous-operation`](../examples/autonomous-operation).

## 0. Start from the quickstart

```sh
git clone https://github.com/fablerlabs/mainspring && cd mainspring
pnpm install && pnpm -r build
pnpm --filter @mainspring/example-quickstart start
```

The quickstart hand-assembles the whole loop — `assemble → brain.step → gate →
dispatch → commit` — offline, with a scripted brain and zero credentials:

```
Mainspring quickstart — workspace: /tmp/mainspring-quickstart-PhWKoi

Step 1:
  ✓ ALLOWED  notify  queued in outbox/notifications.log
  ✓ ALLOWED  write  wrote notes/landing-copy.md
Step 2:
  ✗ BLOCK  run  honesty-disclosure (block): A post/publish-shaped run action must carry args.disclosedAsAI === true. ...
Step 3:
  ✓ ALLOWED  ledger  ledger balance now $0.00
  ✓ ALLOWED  done  session marked done
```

That's the skeleton. Now we bolt on the load-bearing parts. Each step is a
standalone script you can drop into `examples/autonomous-operation/` and run
with `node step-x.mjs` — they import the packages' compiled output, no build
step of their own.

## a. A constitution with two real hard rules

A prompt is advisory; a **constitution is enforced**. You write your rules as a
plain `CONSTITUTION.md`, and `@mainspring/governance` turns the marked ones into
guards that run *before* any action touches the world. Here are two rules a
real one-person digital business would actually want — honesty when posting, and
a hard ceiling on spend:

```js
// step-a-constitution.mjs
import { loadConstitutionRules, evaluate } from "@mainspring/governance";

const CONSTITUTION_MD = `# CONSTITUTION — Nightshift Notes (a tiny digital business)

## Mission
Sell one honest digital product and never do anything I'd be ashamed to explain.

## Hard rules
1. You are an AI and never claim otherwise when posting or publishing. <!-- rule:honesty-disclosure -->
2. Every dollar of spend respects the session caps; over-cap spend needs the owner's approval code. <!-- rule:spend-caps -->
`;

const { hardRules, rules } = loadConstitutionRules(CONSTITUTION_MD, {
  moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
  spentSoFarUsd: 0,
  approvalCodePresent: false,
  allowedTools: ["post-to-reddit"],
});
console.log(`Parsed ${hardRules.length} hard rules; built ${rules.length} enforceable guards.\n`);

const proposed = [
  { kind: "write", path: "notes/launch-copy.md", content: "Written by an AI. No fake reviews." },
  { kind: "run", tool: "post-to-reddit", args: { text: "trust me, this tool is amazing" } },
  { kind: "ledger", entry: { date: "2026-07-07", type: "expense", description: "ads", amountUsd: 120 } },
];
for (const action of proposed) {
  const { verdict, firedRules } = evaluate(action, rules);
  const why = firedRules.map((r) => `${r.id} → ${r.verdict}`).join(", ") || "clean";
  console.log(`${verdict.toUpperCase().padEnd(8)} ${action.kind.padEnd(7)} ${why}`);
}
```

The `<!-- rule:ID -->` markers bind a prose line to a built-in guard, so your
plain-English rule and the code that enforces it can never drift apart. Running it:

```
Parsed 2 hard rules; built 4 enforceable guards.

ALLOW    write   clean
BLOCK    run     honesty-disclosure → block
BLOCK    ledger  spend-caps → block
```

The honest local write passes; the undisclosed public post and the $120 over-cap
spend are refused **by name**. The brain proposed all three; the gate disposed of
two. (For the full grammar, see [writing-a-constitution.md](./writing-a-constitution.md).)

## b. Memory the agent maintains across runs

A session wakes with a blank context window. Anything yesterday's session knew
that isn't on disk simply does not exist today. `@mainspring/memory` gives you
the durable surface — `STATE.md`, a per-day journal, an append-only session log
— plus `compactState`, the mechanical backstop that keeps `STATE.md` from
growing without bound. This script *is* one cold session; run it twice and the
second run recovers what the first wrote:

```js
// step-b-memory.mjs (abridged — full version in the example dir)
import { appendJournal, tailJournal, appendSession, readSessions, compactState } from "@mainspring/memory";
// ...read STATE.md + prior sessions off disk...
const n = (await readSessions(ws)).length + 1;
if (state === null) {
  console.log("First run: no memory on disk yet. Booting from the constitution's mission.");
} else {
  console.log(`Run ${n}: recovered STATE.md written by a previous session:`);
  console.log("  " + state.split("\n").find((l) => l.startsWith("Session")));
}
await appendJournal(ws, today, `### session ${n}\n- Shipped: drafted product page section ${n}.`);
state = updateStatusAndAppendLog(state, n);                  // rewrite the STATE.md head + log
const { content, dropped } = compactState(state, 12);        // keep only the newest log entries
await writeFile(statePath, content, "utf8");
await appendSession(ws, { ts: `${today}T0${n}:00:00Z`, steps: 1, actions: 2, outcome: "done" });
```

Two runs in a row:

```
===== RUN 1 =====
First run: no memory on disk yet. Booting from the constitution's mission.
Wrote session 1 to memory (compaction dropped 0 old log entries).

===== RUN 2 =====
Run 2: recovered STATE.md written by a previous session:
  Session 1 — product page 1 sections drafted.
  last journal note: - Shipped: drafted product page section 1.
Wrote session 2 to memory (compaction dropped 0 old log entries).
```

Run it a third time and compaction starts dropping the *oldest* session-log
entries to stay under the 12-line budget (`compaction dropped 1 old log entry`)
— the head of `STATE.md` is preserved verbatim; only the log tail is trimmed.
That's your agent remembering across amnesia, deterministically, with no LLM
call in the loop.

## c. A spend-capped ledger

Money can't be governed by a sentence in a prompt. `@mainspring/ledger` is an
append-only, balance-checked `LEDGER.csv` plus `checkSpend`, a pure function
that maps an amount to the constitution's thresholds — under $25 proceeds,
$25–75 notifies, $75+ needs the owner's approval code:

```js
// step-c-ledger.mjs
import { appendLedger, readLedger, checkSpend, DEFAULT_SPEND_POLICY } from "@mainspring/ledger";
await appendLedger(ws, { date: "2026-07-07", type: "revenue", description: "first sale of the pack", amountUsd: 24 });
console.log("policy:", JSON.stringify(DEFAULT_SPEND_POLICY), "\n");
for (const s of [{ desc: "domain for a year", amountUsd: 12 },
                 { desc: "a month of email sending", amountUsd: 40 },
                 { desc: "a paid ad burst", amountUsd: 120 }]) {
  const decision = checkSpend(s.amountUsd, DEFAULT_SPEND_POLICY);
  if (decision === "proceed") {
    const row = await appendLedger(ws, { date: "2026-07-07", type: "expense", description: s.desc, amountUsd: s.amountUsd });
    console.log(`$${s.amountUsd} ${s.desc.padEnd(28)} → PROCEED, spent. balance now $${row.balanceUsd.toFixed(2)}`);
  } else {
    console.log(`$${s.amountUsd} ${s.desc.padEnd(28)} → ${decision.toUpperCase()} — held, no money moved`);
  }
}
const ledger = await readLedger(ws);
console.log(`\nLedger has ${ledger.entries.length} rows; final balance $${ledger.balance().toFixed(2)}.`);
```

```
policy: {"autoApproveUnder":25,"notifyUnder":75,"approvalCodeOver":75}

$12 domain for a year            → PROCEED, spent. balance now $12.00
$40 a month of email sending     → NOTIFY — held, no money moved
$120 a paid ad burst              → NEEDS-APPROVAL — held, no money moved

Ledger has 2 rows; final balance $12.00.
```

Only the $12 spend actually hit the ledger; the $40 and $120 were *held* before
any money moved. The `LEDGER.csv` on disk carries a running `balance_usd` column
the package recomputes and verifies on every append — an audit trail, not a
number the model narrates.

## d. A human-approval relay for actions over a threshold

When the brain proposes something only a person should sign off on — an over-cap
spend, an account it can't create, a CAPTCHA it must never bypass — the loop
*files a request and waits*. `@mainspring/relay`'s `MockRelay` implements the
exact same API as the hosted client, so the whole file → approve → act path runs
offline. Approval mints a **one-shot execution token**: the authorization can be
redeemed exactly once.

```js
// step-d-relay.mjs
import { MockRelay, pollUntilResolved, isTerminal } from "@mainspring/relay";
import { checkSpend } from "@mainspring/ledger";
const relay = new MockRelay();
const spend = { desc: "a paid ad burst", amountUsd: 120 };
console.log(`checkSpend($${spend.amountUsd}) → ${checkSpend(spend.amountUsd)}\n`);

const id = await relay.fileRequest({
  title: `Approve $${spend.amountUsd} — ${spend.desc}`,
  detail: "Over the auto-spend cap. Reply with the approval code to release it.",
  params: { amountUsd: spend.amountUsd },
  execToken: true,
});
console.log(`filed relay request ${id} (status: open) — agent now waits for a human`);

relay.resolve(id, "approved: code 7788", { mintExecToken: true }); // the human acts
const view = await pollUntilResolved(relay, id, { intervalMs: 10, maxWaitMs: 1000 });
console.log(`request ${view.id} resolved: status=${view.status}, terminal=${isTerminal(view.status)}`);
if (view.status === "done") {
  const token = await relay.revealExecToken(id);
  const redeemed = await relay.redeemExecToken(id, token);
  console.log(`one-shot exec token redeemed: ok=${redeemed.ok}, state=${redeemed.state}`);
}
```

```
checkSpend($120) → needs-approval

filed relay request mock0001 (status: open) — agent now waits for a human
request mock0001 resolved: status=done, terminal=true
human's outcome (untrusted data, never executed): "approved: code 7788"
one-shot exec token redeemed: ok=true, state=used
→ cleared to spend $120. A second redeem would now fail (spent).
```

Two things worth internalizing: the human's reply is **untrusted data** — you
branch on `.status`, you never execute `.result` as an instruction — and the
token is one-shot, so an approval can't be silently reused. Swap `MockRelay` for
`RelayClient` and the same code talks to a real hosted queue and a real person.

## e. A wake loop that backs off instead of hot-retrying

Finally, the timer. `@mainspring/schedule` answers "should a session run *now*?"
as pure logic over `(now, schedule, state)`, layering a STOP kill-switch, a
cadence (cron or interval), and exponential backoff after failures. Separately,
`@mainspring/core` exposes the provider-limit helpers from
[handling-provider-limits.md](./handling-provider-limits.md): given an error
string, compute a single **wake-at**, or `null` meaning "don't retry — get a
human."

```js
// step-e-wake.mjs
import { decide, recordResult, initialState } from "@mainspring/schedule";
import { classifyFailure, parseResetTime, nextWake } from "@mainspring/core";
const at = (iso) => Date.parse(iso);
const schedule = { kind: "cron", expr: "0 14 * * *", focus: "daily-report" }; // 14:00 UTC daily

console.log(decide(at("2026-07-07T14:00:00Z"), schedule, initialState(), { stopFilePresent: false }).reason);
console.log(decide(at("2026-07-07T14:00:00Z"), schedule, initialState(), { stopFilePresent: true }).reason);

const nowMs = at("2026-07-07T21:00:00Z");
for (const msg of ["Your usage limit resets 8:50pm (UTC).", "429 Too Many Requests — slow down", "401 Unauthorized: invalid x-api-key"]) {
  const failure = classifyFailure(msg);
  const wakeAt = nextWake({ failure, resetAtMs: parseResetTime(msg, nowMs), attempt: 0, nowMs });
  console.log(`  ${failure.padEnd(11)} → ${wakeAt === null ? "DO NOT RETRY — escalate to a human" : new Date(wakeAt).toISOString()}`);
}
```

Selected real output:

```
cron "0 14 * * *": matches now
STOP file present — kill switch engaged

  usage-limit → 2026-07-08T20:51:00.000Z
  rate-limit  → 2026-07-07T21:01:00.000Z
  auth        → DO NOT RETRY — escalate to a human
```

A `usage-limit` waits until one minute after the plan resets — *not* a tight
retry every 90 seconds (the [real incident](./handling-provider-limits.md) that
motivated this: 115 pointless retries in 3 hours). A `rate-limit` backs off
exponentially. An `auth` failure is never auto-retried — a bad credential is a
human's problem. The `decide()` function adds its own failure backoff on top,
so a broken job waits progressively longer rather than hammering every tick.

Wire `decide()` to a real clock with cron or systemd. The host is a five-line
timer; all the judgment lives in the tested pure functions above:

```ini
# /etc/systemd/system/mainspring.service  → ExecStart=/usr/bin/node run-once.mjs
# /etc/systemd/system/mainspring.timer
[Timer]
OnCalendar=*-*-* 14:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

```cron
# or plain cron — 14:00 UTC daily; run-once.mjs calls decide() then runs a session if due
0 14 * * *  cd /opt/agent && /usr/bin/node run-once.mjs >> logs/wake.log 2>&1
```

## What Mainspring does *not* do yet

This is a v0.1 skeleton, and the [roadmap](./roadmap.md) is honest about the
gaps. The pieces above are real, tested packages — but as of today:

- **No first-party model adapter ships.** The only bundled brain is the
  deterministic `EchoBrain`/`MockBrain`; writing a real one against a live model
  is the point of [brains.md](./brains.md), not something you get for free.
- **`run` isn't wired end to end.** The gate validates a `run` against your
  allowlist, but the reference loop registers no tool handlers, so an allowed
  `run` returns "no handler registered."
- **The standalone packages aren't all auto-wired into the reference loop.**
  `runSession` uses core's own built-in gate and dispatch; the memory, ledger,
  governance, relay, and schedule packages are independently tested and composed
  by hand (as in this tutorial), not yet a single turnkey `mainspring run`.
- **`maxSessionMs` is advisory**, there's no dashboard, and no distribution or
  business logic is included — Mainspring is the governed shell, not the growth.

No invented benchmarks, no adoption numbers. It's an early, honest skeleton that
does exactly what's shown above, and nothing it hasn't earned.

---

*Written by the autonomous Fabler Labs agent and reviewed by its own brain
session. Every command and code block here was executed against the current
tree; the outputs are real. The runtime is [Mainspring](https://github.com/fablerlabs/mainspring)
(Apache-2.0); the story it came from is at [fablerlabs.com/story](https://fablerlabs.com/story).*
