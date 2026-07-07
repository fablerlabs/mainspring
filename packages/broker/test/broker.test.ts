import assert from "node:assert/strict";
import { test } from "node:test";
import { Broker } from "../src/broker.js";
import { createMemoryBroker, DEFAULT_SPEND_CAP } from "../src/memoryBroker.js";
import type { BrokerRequest, Capability } from "../src/types.js";

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

const NOTIFY_OWNER: Capability = {
  id: "notify-owner",
  description: "Send a short message to the fixed owner chat id.",
  cap: { maxCallsPerDay: 2, allowlist: ["owner-chat-id"] },
};

function registerEcho(broker: Broker, capability: Capability): void {
  broker.register(capability, (req: BrokerRequest) => ({ echoed: req.op }));
}

// --- unknown capability ------------------------------------------------------

test("request denies and audits an unknown capability without calling any handler", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  const result = await broker.request({ capability: "does-not-exist", op: "ping" });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /unknown capability/);
  assert.equal(broker.audit.length, 1);
  assert.equal(broker.audit[0].allowed, false);
  assert.equal(broker.audit[0].capability, "does-not-exist");
});

// --- allowlist ---------------------------------------------------------------

test("request denies a target not on the capability's allowlist, and denies when target is omitted", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  registerEcho(broker, NOTIFY_OWNER);

  const wrongTarget = await broker.request({ capability: "notify-owner", op: "send", target: "someone-else" });
  assert.equal(wrongTarget.allowed, false);
  assert.match(wrongTarget.reason, /not on allowlist/);

  const noTarget = await broker.request({ capability: "notify-owner", op: "send" });
  assert.equal(noTarget.allowed, false);
  assert.match(noTarget.reason, /not on allowlist/);
});

test("request allows a target present on the capability's allowlist", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  registerEcho(broker, NOTIFY_OWNER);

  const result = await broker.request({ capability: "notify-owner", op: "send", target: "owner-chat-id" });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.output, { echoed: "send" });
});

// --- max amount ----------------------------------------------------------------

test("request denies an amountUsd over the capability's maxAmountUsd", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  registerEcho(broker, { id: "spend", description: "spend", cap: { maxAmountUsd: 75, maxCallsPerDay: 10 } });

  const overCap = await broker.request({ capability: "spend", op: "vps-hosting", amountUsd: 100 });
  assert.equal(overCap.allowed, false);
  assert.match(overCap.reason, /exceeds cap/);

  const atCap = await broker.request({ capability: "spend", op: "vps-hosting", amountUsd: 75 });
  assert.equal(atCap.allowed, true);
});

// --- daily call cap + reset boundary -------------------------------------------

test("request denies once a capability's daily call cap is reached, and resets on the next UTC day", async () => {
  let clockValue = "2026-07-07T10:00:00.000Z";
  const broker = new Broker({ clock: () => new Date(clockValue) });
  registerEcho(broker, { id: "ping", description: "ping", cap: { maxCallsPerDay: 2 } });

  const first = await broker.request({ capability: "ping", op: "a" });
  const second = await broker.request({ capability: "ping", op: "b" });
  const third = await broker.request({ capability: "ping", op: "c" });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.match(third.reason, /daily call cap/);

  clockValue = "2026-07-08T00:00:00.000Z";
  const nextDay = await broker.request({ capability: "ping", op: "d" });
  assert.equal(nextDay.allowed, true);

  const callIndexes = broker.audit.filter((e) => e.allowed).map((e) => e.callIndexToday);
  assert.deepEqual(callIndexes, [1, 2, 1]);
});

test("a denied request does not consume the daily call cap", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  registerEcho(broker, { id: "notify-owner", description: "notify", cap: { maxCallsPerDay: 1, allowlist: ["owner-chat-id"] } });

  const denied = await broker.request({ capability: "notify-owner", op: "spam", target: "attacker" });
  assert.equal(denied.allowed, false);

  const allowed = await broker.request({ capability: "notify-owner", op: "real", target: "owner-chat-id" });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "ok");
});

// --- audit: every attempt, allow and deny ---------------------------------------

test("every attempt — allow and deny alike — appends exactly one audit entry", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  registerEcho(broker, { id: "spend", description: "spend", cap: { maxAmountUsd: 50, maxCallsPerDay: 1 } });

  await broker.request({ capability: "spend", op: "ok-one", amountUsd: 10 });
  await broker.request({ capability: "spend", op: "too-much", amountUsd: 1000 });
  await broker.request({ capability: "unknown-cap", op: "nope" });

  assert.equal(broker.audit.length, 3);
  assert.deepEqual(
    broker.audit.map((e) => e.allowed),
    [true, false, false],
  );
  assert.ok(broker.audit.every((e) => e.timestamp === "2026-07-07T00:00:00.000Z"));
});

test("audit is a frozen snapshot; mutating it cannot affect the broker's own record", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  registerEcho(broker, { id: "ping", description: "ping", cap: { maxCallsPerDay: 5 } });
  await broker.request({ capability: "ping", op: "a" });

  const snapshot = broker.audit;
  assert.throws(() => (snapshot as unknown as unknown[]).push({}));
  assert.equal(broker.audit.length, 1);
});

// --- fail closed: handler throwing --------------------------------------------

test("a handler that throws is denied in the result but still audited and still counted", async () => {
  const broker = new Broker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });
  broker.register({ id: "flaky", description: "flaky", cap: { maxCallsPerDay: 5 } }, () => {
    throw new Error("upstream exploded");
  });

  const result = await broker.request({ capability: "flaky", op: "try" });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /upstream exploded/);
  assert.equal(broker.audit[0].callIndexToday, 1);
});

// --- registration ---------------------------------------------------------------

test("register throws when the same capability id is registered twice", () => {
  const broker = new Broker();
  registerEcho(broker, { id: "dup", description: "dup", cap: { maxCallsPerDay: 1 } });
  assert.throws(() => registerEcho(broker, { id: "dup", description: "dup again", cap: { maxCallsPerDay: 1 } }));
});

// --- memoryBroker: sample "spend" capability wired to @mainspring/ledger -------

test("memoryBroker's spend capability appends to its ledger and reports the running balance", async () => {
  const { broker, ledger } = createMemoryBroker({ clock: fixedClock("2026-07-07T00:00:00.000Z") });

  const first = await broker.request({ capability: "spend", op: "vps-hosting", amountUsd: 20 });
  assert.equal(first.allowed, true);
  assert.deepEqual(first.output, { balanceUsd: -20 });

  const second = await broker.request({ capability: "spend", op: "domain", amountUsd: 12 });
  assert.deepEqual(second.output, { balanceUsd: -32 });

  assert.equal(ledger.balance(), -32);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries[0].description, "vps-hosting");
});

test("memoryBroker's spend capability denies over its configured cap and requires amountUsd", async () => {
  const { broker } = createMemoryBroker({ spendCap: { maxAmountUsd: 25, maxCallsPerDay: 1 } });

  const overAmount = await broker.request({ capability: "spend", op: "too-big", amountUsd: 26 });
  assert.equal(overAmount.allowed, false);

  const missingAmount = await broker.request({ capability: "spend", op: "no-amount" });
  assert.equal(missingAmount.allowed, false);
  assert.match(missingAmount.reason, /requires amountUsd/);
});

test("DEFAULT_SPEND_CAP matches the constitution's notify-band amount and a ten-mutation daily cap", () => {
  assert.deepEqual(DEFAULT_SPEND_CAP, { maxAmountUsd: 75, maxCallsPerDay: 10 });
});
