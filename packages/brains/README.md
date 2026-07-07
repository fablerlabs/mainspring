# @mainspring/brains

Reference `Brain` implementations for `@mainspring/core`: a scripted
`MockBrain` for tests, and a zero-SDK `ClaudeBrain` adapter for Anthropic's
Messages API (plain `fetch`, no `@anthropic-ai/sdk` dependency).

## Install

```sh
npm install @mainspring/brains
```

## Usage

```ts
import { ClaudeBrain } from "@mainspring/brains";
import { runSession } from "@mainspring/core";

const brain = new ClaudeBrain({ apiKey: process.env.ANTHROPIC_API_KEY! });

await runSession({ workspaceDir: "./my-business", constitution, brain });
```

For tests or examples, use `MockBrain` with a scripted array of `StepResult`s
instead of calling a real model.
