# Architecture

## Module map

```
packages/core/src/
  types.ts        shared contracts: Brain, Action, SessionInput, Constitution, ...
  assemble.ts      workspace dir -> SessionInput (the only place that READS context)
  gate.ts          Action -> GateDecision (validates against the Constitution)
  dispatch.ts      allowed Action -> filesystem write (the only place that WRITES)
  loop.ts          runSession(): assemble -> brain.step -> gate -> dispatch -> commit
  defineConfig.ts  typed helper for mainspring.config.ts
  echoBrain.ts     deterministic, zero-API-key reference Brain
  index.ts         barrel export — this is the @mainspring/core public API

packages/cli/src/
  bin.ts           `mainspring` entrypoint, command dispatch
  args.ts          tiny flag parser (no dependency)
  loadConfig.ts    strips types from mainspring.config.ts at runtime, imports it
  commands/
    init.ts        copy templates/default/ into a new workspace dir
    run.ts         load config, call core.runSession(), print a summary
    status.ts       print .mainspring/last-session.json
    doctor.ts       check node/git are present and usable

templates/default/  a fresh, ungenerated workspace (tokens like {{BUSINESS_NAME}}
                     get substituted by `mainspring init`)

examples/hello-business/  the same shape as templates/default, but already
                           filled in and wired to EchoBrain — clone and
                           `mainspring run` immediately, no init step
```

## The trust boundary

`loop.ts` is the only module that calls both `gate.ts` and `dispatch.ts`.
Nothing else in the codebase is allowed to skip the gate and dispatch
directly — that invariant is what makes "the brain is swappable" a safe
claim rather than a hope. A malicious or buggy Brain can propose anything;
the worst it can do is get every Action blocked.

Three properties fall out of that shape:

1. **Money is capped structurally, not by convention.** `gate.ts` tracks
   running session spend and rejects any `ledger` expense Action that would
   cross `constitution.moneyCaps.perSessionUsd`, before dispatch ever
   touches `LEDGER.csv`. See `packages/core/test/gate.test.ts`.
2. **Secrets can't leak through a write or a notify.** `gate.ts` pattern-
   matches `write`/`notify` content against common secret shapes (API keys,
   private key headers, `*_SECRET=`/`*_API_KEY=` assignments) and blocks the
   Action. Brains hold no secrets by contract (`SessionInput` never contains
   one) — this is a second line of defense, not the only one.
3. **Every session is a git commit.** `loop.ts` runs `git add -A && git
   commit` at the end of `runSession()`, so a workspace's history is a
   verifiable audit trail of exactly what each session did, independent of
   whatever the Brain's `journalTail` self-report says.

## How the model is swappable

`SessionInput` is provider-agnostic: plain strings, plain objects, a list of
declarative `ToolSpec`s (name/description/argsSchema — no bound function).
A Brain adapter's entire job is:

1. Turn `SessionInput` + `history: Turn[]` into whatever shape the target
   provider's API wants (a prompt, a tool-calling request, a JSON payload).
2. Call that provider.
3. Turn its response back into `Action[]` — the same seven `kind`s regardless
   of which model produced them.

Nothing upstream (`assemble.ts`) or downstream (`gate.ts`, `dispatch.ts`,
`loop.ts`) knows or cares which provider is behind `step()`. `EchoBrain`
(`packages/core/src/echoBrain.ts`) is the minimal example: it does zero
reasoning and always proposes the same two Actions, but it satisfies the
`Brain` interface exactly like a real model adapter would, which is why
`examples/hello-business` can prove the whole loop with no network access
and no credentials.

A `run` Action names a tool declaratively (`{ kind: "run", tool: string,
args: unknown }`); the handler that actually performs the call is supplied
separately as a `ToolRegistry` passed into `dispatch.ts`'s context, keeping
"what tools exist" (visible to the Brain) separate from "how a tool is
executed" (trusted-side only, never visible to the Brain).

## Broker: capability-gated side effects

`@mainspring/broker` (`packages/broker/src/`) generalizes a pattern already
proven outside this codebase: a side-effect-capable interface that's owned
and reachable only through a narrow, capped surface, so the process asking
for the side effect never holds the raw credential behind it — a root-owned
broker binary outside the agent's own reach, invoked only for a fixed set of
capped operations, is the real-world shape this library models. `Broker`
registers a named `Capability` (e.g. `"spend"`, `"notify-owner"`) with a
`Cap` — a max `amountUsd`, a max `maxCallsPerDay`, and an optional target
`allowlist` — and every `request()` against it is checked before its handler
ever runs.

It fails closed in every direction: an unregistered capability, a missing or
off-allowlist target, an over-amount request, or a request past its daily
call cap are all denied without the handler ever being called. Every
attempt — allow or deny alike — appends one entry to `broker.audit`, so what
was *tried* is as visible as what actually happened. `@mainspring/core`'s own
`gate.ts` enforces the Constitution's money and secret rules inline today
(see the trust boundary above); `broker` is the reusable shape for any other
capability that wants the same fail-closed, fully-audited guarantee without
hand-rolling it.

## Loading `mainspring.config.ts` without a bundler

`packages/cli/src/loadConfig.ts` uses the TypeScript compiler API
(`ts.transpileModule`) to strip types from a workspace's
`mainspring.config.ts` at run time, writes the result to
`<workspace>/.mainspring/config.<timestamp>.mjs`, dynamically `import()`s
it, then deletes the temp file. Writing inside the workspace (rather than
the OS temp dir) matters: it lets Node's module resolution walk upward from
`.mainspring/` and find `node_modules/@mainspring/core` the way it would for
any other file in the workspace.

This is a deliberately small mechanism — no bundler, no extra dependency
beyond `typescript` (already required to build the workspace). A future
version could add source-map support for config-time stack traces, or
support `mainspring.config.mjs` directly for users who'd rather skip
TypeScript in their workspace.

## Known v0.1 gaps (see README → Status)

- No scheduler (`mainspring schedule`) — wiring `mainspring run` to
  cron/systemd is a deployment concern left to the operator for now.
- No dashboard — `mainspring status` and `.mainspring/last-session.json`
  are the only introspection today.
- No first-party model adapters — `EchoBrain` is the only shipped `Brain`;
  writing an OpenAI/Anthropic/local adapter is the natural next package
  (e.g. `@mainspring/brain-anthropic`).
- `CONSTITUTION.md` and `mainspring.config.ts`'s `constitution` object are
  two representations of the same thing, kept in sync by hand. A future
  version could parse structured front-matter out of `CONSTITUTION.md`
  directly instead of duplicating it in TypeScript.
