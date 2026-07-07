import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MockRelay,
  EchoResponder,
  pollUntilResolved,
  RelayClient,
  RelayConfigError,
  RelayHttpError,
  RelayTimeoutError,
  isTerminal,
  TERMINAL_STATES,
} from "../src/index.js";

test("isTerminal agrees with TERMINAL_STATES", () => {
  for (const s of TERMINAL_STATES) assert.equal(isTerminal(s), true);
  assert.equal(isTerminal("open"), false);
  assert.equal(isTerminal("claimed"), false);
});

test("MockRelay: file -> listPending -> resolve -> terminal", async () => {
  const relay = new MockRelay();
  const id = await relay.fileRequest({ title: "create an account", detail: "sign up on the portal" });

  const pending = await relay.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id);
  assert.equal(pending[0].status, "open");

  const view = relay.resolve(id, "done by hand");
  assert.equal(view.status, "done");
  assert.equal(view.result, "done by hand");
  assert.equal(isTerminal(view.status), true);

  // Once terminal it drops out of the pending list.
  assert.equal((await relay.listPending()).length, 0);
});

test("MockRelay: fileRequest rejects an empty title", async () => {
  const relay = new MockRelay();
  await assert.rejects(() => relay.fileRequest({ title: "   " }), RelayHttpError);
});

test("MockRelay: same payload yields a stable sha256 digest", async () => {
  const relay = new MockRelay();
  const input = { title: "t", detail: "d", targetUrl: "https://example.com", params: { a: 1 } };
  const a = await relay.check(await relay.fileRequest(input));
  const b = await relay.check(await relay.fileRequest(input));
  assert.ok(a.payload_digest?.startsWith("sha256:"));
  assert.equal(a.payload_digest, b.payload_digest);
});

test("EchoResponder auto-resolves, and auto-rejects titles asking to be rejected", async () => {
  const relay = new MockRelay();
  const okId = await relay.fileRequest({ title: "please do the thing" });
  const noId = await relay.fileRequest({ title: "reject this one" });

  const responder = new EchoResponder(relay);
  const touched = await responder.runOnce();
  assert.equal(touched.length, 2);

  assert.equal((await relay.check(okId)).status, "done");
  assert.equal((await relay.check(noId)).status, "rejected");
});

test("MockRelay: exec token is one-shot for both reveal and redeem", async () => {
  const relay = new MockRelay();
  const id = await relay.fileRequest({ title: "approve a spend", execToken: true });
  relay.resolve(id, "approved");

  const token = await relay.revealExecToken(id);
  assert.ok(token.length > 0);
  // Second reveal fails — the server drops its copy on first reveal.
  await assert.rejects(() => relay.revealExecToken(id), RelayHttpError);

  const redeemed = await relay.redeemExecToken(id, token);
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.state, "used");
  // Second redeem fails — one-shot authorization is spent.
  await assert.rejects(() => relay.redeemExecToken(id, token), RelayHttpError);
});

test("pollUntilResolved returns the terminal view once a human acts", async () => {
  const relay = new MockRelay();
  const id = await relay.fileRequest({ title: "clear a captcha" });

  const final = await pollUntilResolved(relay, id, {
    intervalMs: 5,
    maxWaitMs: 2000,
    // Stand in for the human resolving mid-wait.
    onTick: () => {
      relay.resolve(id, "cleared");
    },
  });
  assert.equal(final.status, "done");
  assert.equal(final.result, "cleared");
});

test("pollUntilResolved times out when nobody resolves", async () => {
  const relay = new MockRelay();
  const id = await relay.fileRequest({ title: "never resolved" });
  await assert.rejects(
    () => pollUntilResolved(relay, id, { intervalMs: 5, maxWaitMs: 20 }),
    RelayTimeoutError,
  );
});

test("RelayClient validates its construction and inputs without any network", async () => {
  assert.throws(() => new RelayClient({ baseUrl: "", apiKeyEnv: "K" }), RelayConfigError);
  assert.throws(() => new RelayClient({ baseUrl: "https://x", apiKeyEnv: "" }), RelayConfigError);

  const client = new RelayClient({ baseUrl: "https://relay.example.com/", apiKeyEnv: "RELAY_KEY_THAT_IS_UNSET" });
  // Empty title is rejected before any request is attempted.
  await assert.rejects(() => client.fileRequest({ title: "" }), RelayConfigError);
});
