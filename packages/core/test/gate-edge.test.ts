import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gateAction, gateActions } from "../src/index.js";
import { applyActions } from "../src/index.js";
import { runSession } from "../src/index.js";
import type { Action, Brain, Constitution, GateContext, StepResult, Usage } from "../src/index.js";

/** Local shape for a tool registry — mirrors dispatch's accepted param without
 * importing an internal type; keeps this test on the public surface only. */
type SpyRegistry = Record<string, (args: unknown) => Promise<unknown>>;

/**
 * Edge-case hardening for the gate + dispatch path — the security chokepoint
 * every side effect flows through. Companion to gate.test.ts (happy-path) and
 * the governance adversarial suite. Theme throughout: fail-CLOSED. Any
 * ambiguity, malformation, or error must block/contain, never pass or crash.
 */

const constitution: Constitution = {
  name: "Test Business",
  mission: "test",
  hardRules: ["Legal and honest only."],
  moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
  maxSessionMs: 40 * 60 * 1000,
};

const baseCtx = (over: Partial<GateContext> = {}): GateContext => ({
  constitution,
  workspaceDir: "/tmp/workspace",
  spentSoFarUsd: 0,
  tools: [],
  ...over,
});

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, wallMs: 0 };
}

/** A brain that emits one scripted batch, then reports done. Stands in for an
 * untrusted model so we can drive runSession end-to-end deterministically. */
class OnceBrain implements Brain {
  readonly id = "once";
  readonly model = "test-once";
  private used = false;
  constructor(private readonly batch: Action[]) {}
  async step(): Promise<StepResult> {
    if (this.used) return { actions: [{ kind: "done" }], usage: zeroUsage(), done: true };
    this.used = true;
    return { actions: this.batch, usage: zeroUsage(), done: false };
  }
}

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ms-gate-edge-"));
}

// ---------------------------------------------------------------------------
// Unknown / undeclared tool
// ---------------------------------------------------------------------------

test("run action for an undeclared tool is blocked even when other tools exist", () => {
  const decision = gateAction(
    { kind: "run", tool: "shell.exec", args: { cmd: "rm -rf /" } },
    baseCtx({ tools: [{ name: "http.get", description: "fetch a URL" }] }),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /not in the workspace's allowed tool list/);
});

test("run action with an empty tool list blocks every tool (fail-closed default)", () => {
  const decision = gateAction({ kind: "run", tool: "anything", args: {} }, baseCtx({ tools: [] }));
  assert.equal(decision.allowed, false);
});

test("run action with a missing/non-string tool is blocked, not thrown", () => {
  const decision = gateAction(
    { kind: "run", args: {} } as unknown as Action,
    baseCtx({ tools: [{ name: "http.get", description: "" }] }),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /valid string `tool`/);
});

// ---------------------------------------------------------------------------
// Empty action array
// ---------------------------------------------------------------------------

test("gateActions([]) returns [] without touching running spend", () => {
  const decisions = gateActions([], baseCtx());
  assert.deepEqual(decisions, []);
});

test("applyActions([]) is a no-op that resolves to []", async () => {
  const ws = await tempWorkspace();
  try {
    const results = await applyActions([], { workspaceDir: ws });
    assert.deepEqual(results, []);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("runSession handles a brain that proposes zero actions gracefully", async () => {
  const ws = await tempWorkspace();
  try {
    const emptyBrain: Brain = {
      id: "empty",
      model: "test",
      async step(): Promise<StepResult> {
        return { actions: [], usage: zeroUsage(), done: true };
      },
    };
    const summary = await runSession({ workspaceDir: ws, constitution, brain: emptyBrain, commit: false });
    assert.equal(summary.actionsProposed, 0);
    assert.equal(summary.actionsAllowed, 0);
    assert.equal(summary.actionsBlocked, 0);
    assert.equal(summary.done, true);
    // A summary was still written — the session closed cleanly.
    const last = JSON.parse(await readFile(join(ws, ".mainspring", "last-session.json"), "utf8"));
    assert.equal(last.done, true);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Malformed actions: blocked, never thrown-through, never passed
// ---------------------------------------------------------------------------

test("malformed write missing `path` is blocked, not thrown", () => {
  const decision = gateAction({ kind: "write", content: "x" } as unknown as Action, baseCtx());
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /valid string `path`/);
});

test("malformed write missing `content` is blocked (would otherwise skip the secret scan)", () => {
  const decision = gateAction({ kind: "write", path: "notes.md" } as unknown as Action, baseCtx());
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /valid string `content`/);
});

test("write with a non-string `content` is blocked rather than silently passed", () => {
  const decision = gateAction(
    { kind: "write", path: "notes.md", content: { OPENAI_API_KEY: "sk-aaaaaaaaaaaaaaaaaaaaaa" } } as unknown as Action,
    baseCtx(),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /valid string `content`/);
});

test("malformed ledger missing `entry` is blocked, not thrown", () => {
  const decision = gateAction({ kind: "ledger" } as unknown as Action, baseCtx());
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /valid `entry`/);
});

test("ledger with a non-numeric amountUsd is blocked (no NaN slipping past the cap check)", () => {
  const decision = gateAction(
    { kind: "ledger", entry: { date: "2026-01-01", type: "expense", description: "x", amountUsd: "12" } } as unknown as Action,
    baseCtx(),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /finite number/);
});

test("ledger with NaN amountUsd is blocked", () => {
  const decision = gateAction(
    { kind: "ledger", entry: { date: "2026-01-01", type: "expense", description: "x", amountUsd: Number.NaN } } as unknown as Action,
    baseCtx(),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /finite number/);
});

test("malformed notify missing `text` is blocked (would otherwise skip the secret scan)", () => {
  const decision = gateAction({ kind: "notify", to: "owner" } as unknown as Action, baseCtx());
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /valid string `text`/);
});

test("an entirely unknown action kind is blocked", () => {
  const decision = gateAction({ kind: "self-destruct" } as unknown as Action, baseCtx());
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /unknown action kind/);
});

// ---------------------------------------------------------------------------
// enqueue / relay ids cannot escape the workspace (dispatch turns id -> path)
// ---------------------------------------------------------------------------

test("enqueue with a path-traversal id is blocked", () => {
  const decision = gateAction(
    { kind: "enqueue", order: { id: "../../etc/evil", title: "t", body: "b", createdAt: "2026-01-01" } },
    baseCtx(),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /filename-safe string `id`/);
});

test("enqueue with a slash in the id is blocked", () => {
  const decision = gateAction(
    { kind: "enqueue", order: { id: "sub/dir", title: "t", body: "b", createdAt: "2026-01-01" } },
    baseCtx(),
  );
  assert.equal(decision.allowed, false);
});

test("relay with a path-traversal id is blocked", () => {
  const decision = gateAction(
    { kind: "relay", request: { id: "../secret", summary: "s", detail: "d", createdAt: "2026-01-01" } },
    baseCtx(),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /filename-safe string `id`/);
});

test("enqueue and relay with plain filename-safe ids are allowed", () => {
  const enqueue = gateAction(
    { kind: "enqueue", order: { id: "q60-work.order_1", title: "t", body: "b", createdAt: "2026-01-01" } },
    baseCtx(),
  );
  const relay = gateAction(
    { kind: "relay", request: { id: "relay-2026-07-07", summary: "s", detail: "d", createdAt: "2026-01-01" } },
    baseCtx(),
  );
  assert.equal(enqueue.allowed, true);
  assert.equal(relay.allowed, true);
});

// ---------------------------------------------------------------------------
// Mixed batch: some pass, some fail — partial dispatch, both logged
// ---------------------------------------------------------------------------

test("gateActions over a mixed batch blocks the bad ones and passes the good ones without throwing", () => {
  const batch: Action[] = [
    { kind: "write", path: "good.md", content: "hello" },
    { kind: "write", content: "no path" } as unknown as Action, // malformed
    { kind: "write", path: "../escape.md", content: "x" }, // escapes workspace
    { kind: "ledger", entry: { date: "2026-01-01", type: "revenue", description: "sale", amountUsd: 10 } },
  ];
  const decisions = gateActions(batch, baseCtx());
  assert.equal(decisions.length, 4);
  assert.equal(decisions[0].allowed, true);
  assert.equal(decisions[1].allowed, false);
  assert.equal(decisions[2].allowed, false);
  assert.equal(decisions[3].allowed, true);
});

test("runSession partially dispatches a mixed batch: allowed writes land, blocked ones never touch disk, both are logged", async () => {
  const ws = await tempWorkspace();
  try {
    const brain = new OnceBrain([
      { kind: "write", path: "good.md", content: "landed" },
      { kind: "write", path: "../escape.md", content: "should never be written" }, // escapes workspace
      { kind: "write", path: ".env", content: "SECRET=1" }, // forbidden target
    ]);
    const summary = await runSession({ workspaceDir: ws, constitution, brain, commit: false });

    // Allowed write landed.
    assert.equal(await readFile(join(ws, "good.md"), "utf8"), "landed");
    // Blocked writes never reached disk — neither inside nor outside the workspace.
    assert.equal(existsSync(join(ws, ".env")), false);
    assert.equal(existsSync(resolve(ws, "..", "escape.md")), false);

    // Both outcomes recorded in the session log.
    assert.equal(summary.actionsBlocked, 2);
    assert.ok(summary.actionsAllowed >= 1);
    assert.ok(summary.blockedReasons.some((r) => /escapes workspace/.test(r)));
    assert.ok(summary.blockedReasons.some((r) => /forbidden file/.test(r)));

    const last = JSON.parse(await readFile(join(ws, ".mainspring", "last-session.json"), "utf8"));
    assert.equal(last.actionsBlocked, 2);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Blocked actions are NEVER dispatched (spy on the tool registry)
// ---------------------------------------------------------------------------

test("dispatch is never invoked for a blocked action (registry spy)", async () => {
  const ws = await tempWorkspace();
  try {
    const invoked: string[] = [];
    const registry: SpyRegistry = {
      "safe.tool": async () => {
        invoked.push("safe.tool");
        return "ok";
      },
      "danger.tool": async () => {
        invoked.push("danger.tool");
        return "ran";
      },
    };
    // danger.tool is a real handler but NOT declared in the allowed tool list.
    const tools = [{ name: "safe.tool", description: "" }];
    const batch: Action[] = [
      { kind: "run", tool: "safe.tool", args: {} },
      { kind: "run", tool: "danger.tool", args: {} },
    ];

    // Mirror the loop: gate, then dispatch only what was allowed.
    const decisions = gateActions(batch, baseCtx({ workspaceDir: ws, tools }));
    const allowed = decisions.filter((d) => d.allowed).map((d) => d.action);
    await applyActions(allowed, { workspaceDir: ws, toolRegistry: registry });

    assert.deepEqual(invoked, ["safe.tool"]); // danger.tool was blocked and never dispatched
    assert.equal(decisions[1].allowed, false);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A throwing tool handler is contained, state is not corrupted
// ---------------------------------------------------------------------------

test("a throwing tool handler is contained: batch resolves, failure recorded, later actions still apply", async () => {
  const ws = await tempWorkspace();
  try {
    const registry: SpyRegistry = {
      "boom": async () => {
        throw new Error("handler exploded");
      },
    };
    const batch: Action[] = [
      { kind: "run", tool: "boom", args: {} },
      { kind: "write", path: "after.md", content: "still ran" },
    ];
    // applyActions must NOT reject even though the handler throws.
    const results = await applyActions(batch, { workspaceDir: ws, toolRegistry: registry });

    assert.equal(results[0].applied, false);
    assert.match(results[0].detail ?? "", /threw: handler exploded/);
    // The action after the failure was still applied — state is intact.
    assert.equal(results[1].applied, true);
    assert.equal(await readFile(join(ws, "after.md"), "utf8"), "still ran");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: valid actions still pass unchanged
// ---------------------------------------------------------------------------

test("well-formed write / ledger / notify / run still pass after hardening", () => {
  const write = gateAction({ kind: "write", path: "notes.md", content: "clean" }, baseCtx());
  const ledger = gateAction(
    { kind: "ledger", entry: { date: "2026-01-01", type: "expense", description: "x", amountUsd: 5 } },
    baseCtx(),
  );
  const notify = gateAction({ kind: "notify", to: "owner", text: "hi" }, baseCtx());
  const run = gateAction({ kind: "run", tool: "http.get", args: {} }, baseCtx({ tools: [{ name: "http.get", description: "" }] }));
  const done = gateAction({ kind: "done" }, baseCtx());
  assert.equal(write.allowed, true);
  assert.equal(ledger.allowed, true);
  assert.equal(notify.allowed, true);
  assert.equal(run.allowed, true);
  assert.equal(done.allowed, true);
});
