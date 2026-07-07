/**
 * E2E: @mainspring/relay's public API vs a REAL relay worker (`wrangler dev`
 * running oss/relay-oss/src/index.js), not the in-memory MockRelay the rest
 * of this package's tests use. `relay.test.ts` proves the client's own
 * request/response handling in isolation; this file proves the wire shapes
 * it assumes (field names, status codes, JSON bodies) match what the actual
 * OSS worker sends and expects — the two are maintained independently and
 * could drift.
 *
 * The agent side is driven exclusively through `RelayClient`/`pollUntilResolved`
 * (the package's public API). The human/portal side has no client in this
 * package by design, so it's driven with plain `fetch`, per the work order.
 *
 * If wrangler can't boot in this sandbox (no network egress for the worker
 * runtime download, no `npx` available, etc.), every test below is skipped
 * with the boot error as the reason — never faked as a pass.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { RelayClient, RelayHttpError, pollUntilResolved } from "../src/index.js";
import { startRelay, type RelayHarness } from "./wrangler-harness.js";

let harness: RelayHarness | undefined;
let bootError: string | undefined;

try {
  harness = await startRelay();
} catch (err) {
  bootError = err instanceof Error ? err.message : String(err);
}

after(() => {
  harness?.stop();
});

if (bootError) {
  test(`relay-e2e SKIPPED: wrangler dev could not boot in this sandbox — ${bootError}`, (t) => {
    t.skip(bootError);
  });
} else {
  const h = harness!;

  test("RelayClient: file -> poll -> portal-side completion (real wrangler dev worker)", async () => {
    const client = new RelayClient({ baseUrl: h.baseUrl, apiKeyEnv: h.agentKeyEnvVar });

    const id = await client.fileRequest({
      title: "e2e: approve a spend",
      detail: "mainspring relay-e2e suite filing against a real wrangler dev worker",
    });

    const filed = await client.check(id);
    assert.equal(filed.status, "open");

    // Drive the human/portal side directly: this package intentionally has no
    // portal client, so a plain fetch stands in for the human tapping "Mark done".
    const cookie = await h.portalLogin();
    const completeRes = await fetch(`${h.baseUrl}/va/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-Relay-Portal": "1" },
      body: JSON.stringify({ id, result: "approved by relay-e2e portal stand-in" }),
    });
    assert.equal(completeRes.status, 200, `portal complete should 200, got ${completeRes.status}`);

    const resolved = await pollUntilResolved(client, id, { intervalMs: 100, maxWaitMs: 15_000 });
    assert.equal(resolved.status, "done");
    assert.equal(resolved.result, "approved by relay-e2e portal stand-in");
  });

  test("RelayClient: exec-token mint -> reveal-once -> redeem-once (real wrangler dev worker)", async () => {
    const client = new RelayClient({ baseUrl: h.baseUrl, apiKeyEnv: h.agentKeyEnvVar });

    const id = await client.fileRequest({ title: "e2e: clear a captcha", execToken: true });
    assert.equal((await client.check(id)).status, "open");

    const cookie = await h.portalLogin();
    const completeRes = await fetch(`${h.baseUrl}/va/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-Relay-Portal": "1" },
      body: JSON.stringify({ id, result: "cleared it" }),
    });
    assert.equal(completeRes.status, 200);

    const approved = await client.check(id);
    assert.equal(approved.exec_token?.state, "issued");

    const token = await client.revealExecToken(id);
    assert.ok(token.startsWith("fxt_"), `token should carry the server's fxt_ prefix, got ${token}`);
    await assert.rejects(() => client.revealExecToken(id), RelayHttpError, "second reveal must be refused");

    const redeemed = await client.redeemExecToken(id, token);
    assert.equal(redeemed.ok, true);
    assert.equal(redeemed.state, "used");
    await assert.rejects(() => client.redeemExecToken(id, token), RelayHttpError, "second redeem must be refused");
  });

  test("RelayClient: secret-gate rejection surfaces as a typed RelayHttpError(422)", async () => {
    const client = new RelayClient({ baseUrl: h.baseUrl, apiKeyEnv: h.agentKeyEnvVar });
    // Obviously-synthetic (all-zero) Stripe-shaped key; never a real secret.
    // Assembled at runtime so no contiguous secret-shaped literal sits in this file.
    const fakeKey = ["sk", "live", "0".repeat(16)].join("_");

    await assert.rejects(
      () => client.fileRequest({ title: "e2e: secret gate", detail: `leaking a key ${fakeKey} in the body` }),
      (err: unknown) => {
        assert.ok(err instanceof RelayHttpError, `expected RelayHttpError, got ${err}`);
        assert.equal((err as RelayHttpError).status, 422);
        return true;
      },
    );
  });
}
