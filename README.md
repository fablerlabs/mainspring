# Mainspring

**Mainspring is an open-source operating system for running a *business*, not
a task.**

You give it a constitution — a mission, hard rules, and money caps, written
as a plain markdown file. You plug in any LLM as its "brain." It wakes on a
timer, forever: reads its own memory from disk, does a slice of work, keeps
a real ledger, and hands anything it can't safely do alone to a
human-approval queue and a live dashboard. Then it goes back to sleep until
the next wake-up, with no memory except what it wrote to disk.

Where [LangChain](https://github.com/langchain-ai/langchain),
[AutoGPT](https://github.com/Significant-Gravitas/AutoGPT), and
[CrewAI](https://github.com/crewAIInc/crewAI) orchestrate agents to finish a
**task**, Mainspring is the runtime for a persistent **operation**: durable
memory across amnesiac sessions, real accounting, capped and governed side
effects, a leak-proof publish gate, and human-in-the-loop oversight — all
model-agnostic.

**The wedge, in three words: MEMORY. MONEY. GOVERNANCE.**

Built by an autonomous AI agent ([Fabler Labs](https://fablerlabs.com)) as
part of a real, running, revenue-tracked experiment — this repo is that
agent's own runtime, open-sourced. See [`docs/architecture.md`](docs/architecture.md)
for the module map.

## The loop

```
 ┌───────────────────────────────────────────────────────────────────┐
 │  wake on a timer (cron / systemd / anything that runs `mainspring  │
 │  run` on a schedule) — the process itself holds no memory          │
 └──────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   assemble.ts    │  read STATE.md, journal tail,
                        │                  │  LEDGER.csv tail, inbox/,
                        │                  │  health.json, relay/, queue/
                        └────────┬─────────┘
                                 │  SessionInput
                                 ▼
                        ┌─────────────────┐
                        │   Brain.step()   │  PURE reasoning. Proposes
                        │  (swappable)     │  Action[]. Never touches disk,
                        │                  │  network, or a secret.
                        └────────┬─────────┘
                                 │  Action[]
                                 ▼
                        ┌─────────────────┐
                        │     gate.ts      │  checks every Action against
                        │                  │  the Constitution: money caps,
                        │                  │  path safety, secret patterns,
                        │                  │  allowed tools. Blocks + logs
                        │                  │  the reason; never throws away
                        │                  │  the "why."
                        └────────┬─────────┘
                                 │  allowed Action[]
                                 ▼
                        ┌─────────────────┐
                        │   dispatch.ts    │  the ONLY code that writes to
                        │                  │  disk: journal/state/queue/
                        │                  │  relay files, LEDGER.csv,
                        │                  │  outbox/notifications.log
                        └────────┬─────────┘
                                 │
                                 ▼
                        git add -A && git commit   (the loop's memory
                                                     write is durable and
                                                     auditable by construction)
                                 │
                                 ▼
                     sleep until the next scheduled wake-up
```

`assemble → Brain.step → gate → dispatch` is the whole trust boundary. A
Brain can propose anything; it can never execute anything. That split is
what makes the brain swappable — and what makes the operation safe to leave
running unattended.

## 60-second quickstart

```bash
npx @mainspring/cli init my-biz --brain echo
cd my-biz
pnpm install        # links @mainspring/core (or: npm install / yarn)
mainspring run      # EchoBrain: no API key, writes a journal + ledger line, commits
mainspring status    # see what the last session did
mainspring schedule  # (roadmap) install a cron/systemd timer to wake it forever
```

Swap `EchoBrain` for a real model by editing `mainspring.config.ts` — see
the Brain interface below.

## The Brain interface

A Brain is **pure reasoning**: given the current state of the business, it
proposes a list of `Action`s. It never touches the filesystem, the network,
or a secret directly — only the session loop does that, and only after
every `Action` clears the gate.

```ts
interface Brain {
  readonly id: string;
  readonly model: string;
  step(input: SessionInput, history: Turn[]): Promise<StepResult>;
  estimateCost?(usage: Usage): Money;
}

type Action =
  | { kind: "run"; tool: string; args: unknown }
  | { kind: "write"; path: string; content: string }
  | { kind: "ledger"; entry: LedgerEntry }
  | { kind: "enqueue"; order: WorkOrder }
  | { kind: "relay"; request: RelayRequest }
  | { kind: "notify"; to: "owner"; text: string; priority?: "high" }
  | { kind: "done" };

interface StepResult {
  actions: Action[];
  usage: Usage;
  done: boolean;
}
```

Because `step()` is the entire surface area, adapting a new model/provider
is one file: translate `SessionInput` into that provider's prompt/tool-call
format, translate its response back into `Action[]`. `@mainspring/core`
ships `EchoBrain` — a deterministic, zero-API-key Brain that proves the loop
end to end — as the reference implementation to copy from.

## Mainspring vs. task-orchestration frameworks

| | Mainspring | LangChain / AutoGPT / CrewAI |
|---|---|---|
| Unit of work | a **business**, running forever | a **task**, run to completion |
| Memory | durable, on-disk, survives amnesiac sessions (`STATE.md`, journal, ledger) by design | typically in-process; persistence is bolted on per app |
| Money | first-class `ledger` Action + enforced caps (`gate.ts`) | not modeled — spend tracking is DIY |
| Governance | every side effect passes a Constitution-checked gate before it happens | tool calls generally execute directly |
| Human oversight | built-in `relay` (approval queue) + `notify` Actions | ad hoc, if present |
| Model swap | one `Brain.step()` adapter; loop and gate never change | usually means re-plumbing the app |

## Honesty note

This project was built end-to-end by an autonomous AI agent operating under
its own constitution (the same pattern this framework generalizes), as part
of [Fabler Labs](https://fablerlabs.com)'s public experiment in running a
real business with an AI operator. It is offered as-is under the
[Apache-2.0](LICENSE) license. Nothing in this repo, its docs, or its
example workspace contains real credentials, customer data, or Fabler
Labs–specific business logic — `templates/default/` and
`examples/hello-business/` are generic starting points.

## Repo layout

```
mainspring/
  packages/core/     the Brain contract + the constitution-enforcing loop
  packages/cli/       `mainspring` bin: init / run / status / doctor
  templates/default/  a fresh workspace, scaffolded by `mainspring init`
  examples/hello-business/  a ready-to-run workspace (EchoBrain, no API key)
  docs/architecture.md      module map + how brain-swapping works
```

## Status

Early skeleton (v0.1). The loop, gate, dispatch, CLI, and EchoBrain are
real and tested. Scheduling (`mainspring schedule`), a dashboard, and
first-party model adapters (OpenAI/Anthropic/local) are on the roadmap —
contributions welcome.
