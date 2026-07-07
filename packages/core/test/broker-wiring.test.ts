import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Broker } from "@mainspring/broker";
import { applyAction, applyActions } from "../src/dispatch.js";
import type { Action } from "../src/types.js";

/**
 * Wiring tests for the dispatch <-> @mainspring/broker seam. These exercise
 * the *real* broker package (imported above) to prove caps/allowlists/audit
 * are enforced by it, not by inline copies in dispatch. Every test uses a
 * fresh temp workspace so disk effects can be asserted (or their absence,
 * on a broker deny).
 */

const FIXED = "2026-07-07T00:00:00.000Z";
const fixedClock = (): Date => new Date(FIXED);

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mainspring-broker-wiring-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A broker wired the way a real workspace would: spend/notify-owner/relay capabilities whose handlers only authorize — dispatch performs the workspace effect. */
function wiredBroker(spendMaxUsd = 75): Broker {
  const broker = new Broker({ clock: fixedClock });
  broker.register({ id: "spend", description: "capped expense", cap: { maxAmountUsd: spendMaxUsd, maxCallsPerDay: 10 } }, () => ({ authorized: true }));
  broker.register({ id: "notify-owner", description: "message the owner", cap: { maxCallsPerDay: 5, allowlist: ["owner"] } }, () => ({ authorized: true }));
  broker.register({ id: "relay", description: "file a human blocker", cap: { maxCallsPerDay: 5 } }, () => ({ authorized: true }));
  return broker;
}

const expense = (amountUsd: number, description = "vps-hosting"): Action => ({
  kind: "ledger",
  entry: { date: FIXED, type: "expense", description, amountUsd },
});

async function readLedger(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, "LEDGER.csv"), "utf8");
  } catch {
    return "";
  }
}

// --- 1. allow path ------------------------------------------------------------

test("allow path: a within-cap expense is authorized by the broker, then written to the ledger and audited", async () => {
  await withWorkspace(async (dir) => {
    const broker = wiredBroker();
    const result = await applyAction(expense(20), { workspaceDir: dir, broker });

    assert.equal(result.applied, true);
    assert.match(result.detail ?? "", /ledger balance now \$-20\.00/);

    // The effect actually happened on disk.
    assert.match(await readLedger(dir), /expense,vps-hosting,20\.00,-20\.00/);

    // Exactly one audit entry, allowed, for the spend capability.
    assert.equal(broker.audit.length, 1);
    assert.equal(broker.audit[0].allowed, true);
    assert.equal(broker.audit[0].capability, "spend");
    assert.equal(broker.audit[0].amountUsd, 20);
  });
});

// --- 2. over-cap deny ---------------------------------------------------------

test("over-cap deny: an expense over the broker's per-request cap is refused with the broker's reason and nothing hits the ledger", async () => {
  await withWorkspace(async (dir) => {
    const broker = wiredBroker(75);
    const result = await applyAction(expense(100), { workspaceDir: dir, broker });

    assert.equal(result.applied, false);
    assert.match(result.detail ?? "", /^broker denied: /);
    assert.match(result.detail ?? "", /exceeds cap 75/);

    // Fail-closed: the workspace effect never ran.
    assert.equal(await readLedger(dir), "");

    assert.equal(broker.audit.length, 1);
    assert.equal(broker.audit[0].allowed, false);
  });
});

// --- 3. unregistered-capability deny (fail closed) ----------------------------

test("unregistered-capability deny: a notify against a broker that never registered notify-owner is refused fail-closed, no outbox written", async () => {
  await withWorkspace(async (dir) => {
    // Only "spend" is registered — the notify-owner capability is absent.
    const broker = new Broker({ clock: fixedClock });
    broker.register({ id: "spend", description: "spend", cap: { maxAmountUsd: 75, maxCallsPerDay: 10 } }, () => ({ authorized: true }));

    const result = await applyAction({ kind: "notify", to: "owner", text: "hello" }, { workspaceDir: dir, broker });

    assert.equal(result.applied, false);
    assert.match(result.detail ?? "", /broker denied: unknown capability: notify-owner/);

    // No side effect: the outbox log was never created.
    await assert.rejects(readFile(join(dir, "outbox", "notifications.log"), "utf8"));

    assert.equal(broker.audit.length, 1);
    assert.equal(broker.audit[0].allowed, false);
    assert.equal(broker.audit[0].capability, "notify-owner");
  });
});

// --- 4. audit ordering --------------------------------------------------------

test("audit ordering: brokered attempts are audited in dispatch order, and workspace-local actions are not brokered at all", async () => {
  await withWorkspace(async (dir) => {
    const broker = wiredBroker(75);
    const actions: Action[] = [
      expense(10, "first"), // allow
      { kind: "write", path: "notes.md", content: "not a side effect the broker mediates" }, // not brokered
      { kind: "notify", to: "owner", text: "ping" }, // allow (target "owner" on allowlist)
      expense(1000, "too-big"), // deny (over cap)
      { kind: "done" }, // not brokered
    ];

    const results = await applyActions(actions, { workspaceDir: dir, broker });

    // Dispatch outcomes line up with the actions.
    assert.deepEqual(
      results.map((r) => r.applied),
      [true, true, true, false, true],
    );

    // Only the three brokered actions were audited, in order; write/done never touched the broker.
    assert.deepEqual(
      broker.audit.map((e) => ({ capability: e.capability, op: e.op, allowed: e.allowed })),
      [
        { capability: "spend", op: "first", allowed: true },
        { capability: "notify-owner", op: "notify", allowed: true },
        { capability: "spend", op: "too-big", allowed: false },
      ],
    );

    // The non-brokered write still landed on disk.
    assert.equal(await readFile(join(dir, "notes.md"), "utf8"), "not a side effect the broker mediates");
  });
});

// --- 5. no-broker default path ------------------------------------------------

test("no-broker default path: dispatch behaves exactly as before when no broker is injected", async () => {
  await withWorkspace(async (dir) => {
    const expenseResult = await applyAction(expense(50), { workspaceDir: dir });
    assert.equal(expenseResult.applied, true);
    assert.match(await readLedger(dir), /expense,vps-hosting,50\.00,-50\.00/);

    const writeResult = await applyAction({ kind: "write", path: "a.txt", content: "hi" }, { workspaceDir: dir });
    assert.equal(writeResult.applied, true);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "hi");
  });
});

// --- extra: run composes broker authorization with the tool registry ----------

test("run: an unregistered tool capability is denied by the broker before any handler runs", async () => {
  await withWorkspace(async (dir) => {
    const broker = wiredBroker(); // no "http.get" capability registered
    let handlerCalls = 0;
    const result = await applyAction(
      { kind: "run", tool: "http.get", args: { url: "https://example.com" } },
      { workspaceDir: dir, broker, toolRegistry: { "http.get": async () => (handlerCalls++, { status: 200 }) } },
    );

    assert.equal(result.applied, false);
    assert.match(result.detail ?? "", /broker denied: unknown capability: http\.get/);
    assert.equal(handlerCalls, 0); // fail-closed: the tool handler never ran
  });
});

test("run: a registered tool capability is authorized by the broker, then executed via the tool registry", async () => {
  await withWorkspace(async (dir) => {
    const broker = wiredBroker();
    broker.register({ id: "http.get", description: "fetch a url", cap: { maxCallsPerDay: 3 } }, () => ({ authorized: true }));
    const result = await applyAction(
      { kind: "run", tool: "http.get", args: { url: "https://example.com" } },
      { workspaceDir: dir, broker, toolRegistry: { "http.get": async () => ({ status: 200 }) } },
    );

    assert.equal(result.applied, true);
    assert.match(result.detail ?? "", /ran http\.get/);
    const audited = broker.audit.filter((e) => e.capability === "http.get");
    assert.equal(audited.length, 1);
    assert.equal(audited[0].allowed, true);
  });
});
