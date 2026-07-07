# @mainspring/memory

Durable, deterministic utilities for the amnesiac session loop: `STATE.md`
compaction, the per-day journal, and the append-only session log. Zero
runtime dependencies, no LLM calls.

## Install

```sh
npm install @mainspring/memory
```

## Usage

```ts
import { compactState, appendJournal, appendSession } from "@mainspring/memory";

const { content } = compactState(stateMd, 200);

await appendJournal("./my-business", "2026-07-07", "- Shipped v1 landing page.");
await appendSession("./my-business", { ts: new Date().toISOString(), steps: 3, actions: 2, outcome: "done" });
```

`compactState` keeps `STATE.md`'s head verbatim and drops the oldest
session-log entries once the file exceeds `maxLines` — deterministic, no
model call required.
