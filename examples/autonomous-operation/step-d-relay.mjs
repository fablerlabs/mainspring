// Step (d): a human-approval relay stub. When the brain proposes something
// only a person should sign off on (here: a spend over the cap), the loop files
// a request and waits. MockRelay stands in for the hosted queue + human portal,
// so the whole file → approve → act path runs with no network and no secrets.
import { MockRelay, pollUntilResolved, isTerminal } from "@mainspring/relay";
import { checkSpend } from "@mainspring/ledger";

const relay = new MockRelay();

async function requestApproval(spend) {
  const id = await relay.fileRequest({
    title: `Approve $${spend.amountUsd} — ${spend.desc}`,
    detail: "Over the auto-spend cap. Reply with the approval code to release it.",
    params: { amountUsd: spend.amountUsd },
    execToken: true, // mint a one-shot authorization on approval
  });
  console.log(`filed relay request ${id} (status: open) — agent now waits for a human`);
  return id;
}

// --- The over-cap spend the brain wants to make ---
const spend = { desc: "a paid ad burst", amountUsd: 120 };
console.log(`checkSpend($${spend.amountUsd}) → ${checkSpend(spend.amountUsd)}\n`);

const id = await requestApproval(spend);

// A real run would poll a hosted queue; here the "human" acts, then we poll the
// same in-memory API the real client implements. resolve() mints the exec token.
relay.resolve(id, "approved: code 7788", { mintExecToken: true });

const view = await pollUntilResolved(relay, id, { intervalMs: 10, maxWaitMs: 1000 });
console.log(`request ${view.id} resolved: status=${view.status}, terminal=${isTerminal(view.status)}`);
console.log(`human's outcome (untrusted data, never executed): "${view.result}"`);

if (view.status === "done") {
  const token = await relay.revealExecToken(id);      // one-time reveal
  const redeemed = await relay.redeemExecToken(id, token); // one-time redeem
  console.log(`one-shot exec token redeemed: ok=${redeemed.ok}, state=${redeemed.state}`);
  console.log(`→ cleared to spend $${spend.amountUsd}. A second redeem would now fail (spent).`);
} else {
  console.log("→ not approved; the spend never happens.");
}
