# @mainspring/core

The swappable-brain contract and the constitution-enforcing session loop —
the heart of Mainspring's wake-work-sleep cycle.

## Install

```sh
npm install @mainspring/core
```

## Usage

```ts
import { defineConfig, runSession, EchoBrain } from "@mainspring/core";

const config = defineConfig({
  constitution: {
    name: "My Business",
    mission: "Build and run a small, honest digital product.",
    hardRules: ["Legal and honest only.", "You are an AI and never claim otherwise."],
    moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
    maxSessionMs: 40 * 60_000,
  },
  brain: new EchoBrain(),
});

const summary = await runSession({
  workspaceDir: "./my-business",
  constitution: config.constitution,
  brain: config.brain,
});
```

`runSession` assembles the `SessionInput` from disk, calls the `Brain` in a
loop, gates every proposed `Action` against the constitution, dispatches
what's allowed, and commits the workspace.

## Broker seam (optional caps/allowlists/audit)

`dispatch` accepts an optional [`@mainspring/broker`](../broker) `Broker`.
Pass one to `runSession({ ..., broker })` (or `applyAction(action, { ...,
broker })`) and every money-moving/external Action — an `expense` ledger
line, `run`, `notify`, `relay` — is first put through `broker.request()`:
caps, allowlists, and an append-only audit are enforced by the real broker
package, not by inline copies here. A denial (over-cap, off-allowlist, or an
**unregistered capability** — fail-closed) blocks the Action and surfaces the
broker's reason; only on allow does the workspace effect run. Workspace-local
Actions (`write`, `enqueue`, `done`) are never brokered.

The seam is structural (`BrokerLike`), so `core` keeps zero runtime
dependencies — inject a `Broker` whose capabilities you registered:

```ts
import { Broker } from "@mainspring/broker";

const broker = new Broker();
broker.register({ id: "spend", description: "capped expense", cap: { maxAmountUsd: 75, maxCallsPerDay: 10 } }, authorize);
broker.register({ id: "notify-owner", description: "message the owner", cap: { maxCallsPerDay: 5, allowlist: ["owner"] } }, authorize);

const summary = await runSession({ workspaceDir, constitution, brain, broker });
```

Omit `broker` and dispatch behaves exactly as before.

## Governance seam (optional constitution-as-code)

`gate` accepts an optional [`@mainspring/governance`](../governance) guard.
Pass one to `runSession({ ..., governance })` (or `gateAction(action, { ...,
governance })`) and every Action the built-in gate would **allow** is
additionally checked against the constitution-as-code rule set. A `block` or
`escalate` verdict turns the allow into a denial whose reason carries the
fired rules' constitution citations; the guard is consulted *only* for Actions
the built-ins already allow, so governance can add hard-rule restrictions but
never loosen a built-in denial. A guard that throws (e.g. on an unparseable
`CONSTITUTION.md`) fails **closed** — the Action is denied.

The seam is structural (`GovernanceGuard`), so `core` keeps zero runtime
dependencies — bind `governance`'s `evaluate` to rules loaded from a
`CONSTITUTION.md`:

```ts
import { loadConstitutionFile, evaluate } from "@mainspring/governance";

const { rules } = await loadConstitutionFile("./CONSTITUTION.md", {
  moneyCaps: constitution.moneyCaps,
  allowedTools: tools.map((t) => t.name),
});
const governance = (action) => evaluate(action, rules);

const summary = await runSession({ workspaceDir, constitution, brain, governance });
```

Omit `governance` and the gate behaves exactly as before.
