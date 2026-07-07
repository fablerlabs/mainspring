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
