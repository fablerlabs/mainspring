# Roadmap

An honest map of what Mainspring is today and where it's going. No dates, no
vaporware — items move forward only when the code on `main` supports them. If
something here is marked done, it is real and tested; if it's planned, it isn't
built yet.

The organizing principle never changes: **the Brain proposes, the
Constitution-checked loop disposes.** Every version below preserves the trust
boundary in [architecture.md](./architecture.md) — new capability is added
*around* `assemble → gate → dispatch → commit`, never by letting a Brain skip it.

## v0.1 — skeleton, gate, echo brain (today)

Shipped and tested (`packages/core`, `packages/cli`):

- **The loop** — `runSession` in `loop.ts`: assemble → `brain.step()` → gate →
  dispatch → `git commit`, with a `maxSteps` safety valve.
- **The gate** — `gate.ts`: money caps enforced structurally (per-session spend
  ceiling), workspace-path safety, `.env`/`.git` write protection, and
  secret-shaped-content blocking on `write`/`notify`. Covered by
  `packages/core/test/gate.test.ts`.
- **Dispatch** — `dispatch.ts`: the only filesystem writer; applies `write`,
  `ledger` (with running-balance computation), `enqueue`, `relay`, `notify`, and
  `done`.
- **`EchoBrain`** — a deterministic, zero-API-key reference Brain that proves the
  loop end to end with no network and no credentials.
- **CLI** — `mainspring init | run | status | doctor`.
- **The Brain contract** — the `Brain` / `Action` / `SessionInput` types and the
  [writing-a-brain guide](./brains.md).

Known gaps in v0.1 (documented, not hidden):

- **No first-party model adapter.** `EchoBrain` is the only shipped Brain;
  writing a real one is the point of [brains.md](./brains.md).
- **`run` isn't wired end to end.** The gate validates a `run` against the
  allowed tool list, but `runSession` doesn't pass a `ToolRegistry` to dispatch,
  so an allowed `run` returns `applied: false` ("no handler registered"). Tools
  can be *declared* to the Brain and *gated*, but not yet *executed*.
- **No gate feedback to the Brain.** The loop pushes only `role: "brain"` turns
  into `history`; the `role: "loop"` turn exists in the types but is never
  emitted, so a Brain sees a veto only indirectly (via the next `assemble()`).
- **`maxSessionMs` is advisory.** The loop enforces `maxSteps`, not a wall-clock
  deadline; `brain.step()` is not wrapped in a try/catch (a throw aborts the
  session before commit).
- **No scheduler** — wiring `mainspring run` to cron/systemd is left to the
  operator.
- **No dashboard** — `mainspring status` and `.mainspring/last-session.json` are
  the only introspection.

## v0.2 — memory, scrub, relay packages (in progress)

Standalone packages that already exist in the repo and are being brought up to
the same tested bar as core:

- **`@mainspring/memory`** — helpers for the durable memory surface a Brain
  writes to (STATE, journal, session log), so adapters don't hand-roll file
  layout. (`packages/memory`)
- **`@mainspring/scrub`** — a pre-publish leak gate: scan text for secret- and
  PII-shaped content and replace it with placeholders, for anything a business
  publishes to the outside world. (`packages/scrub`)
- **`@mainspring/relay`** — a typed client and mock for the human-in-the-loop
  approval queue that `relay` Actions feed, so blockers can be cleared by an
  operator or a hosted service. (`packages/relay`)

Also targeted for v0.2: closing the two loop gaps above — thread gate decisions
back to the Brain as `role: "loop"` turns, and wrap `brain.step()` so a provider
error degrades cleanly instead of aborting the session.

## v0.3 — claude-brain adapter and the broker pattern (planned)

- **`@mainspring/brain-claude`** — a first-party adapter turning the
  [worked example in brains.md](./brains.md#worked-example-a-claude-brain-adapter)
  into a shipped, tested package: Anthropic Messages API, tool-use mapped to
  Actions, `ANTHROPIC_API_KEY` read at runtime (never stored), model as config.
  The same shape generalizes to other providers (`brain-openai`, a local-model
  adapter) — one `step()` per provider, loop and gate unchanged.
- **`ToolRegistry` wired through the loop** — give `runSession` a way to register
  tool handlers so `run` Actions actually execute (closing the v0.1 gap), keeping
  "what tools exist" (visible to the Brain) separate from "how a tool runs"
  (trusted-side only).
- **A broker for capped spending** — a small trusted component that turns an
  approved, gate-checked `ledger` expense into a real payment against a
  provisioned, capped virtual card, so a business can spend within its
  Constitution's `moneyCaps` without ever handing card details to the Brain.
  Spending stays structurally bounded: the gate rejects over-cap expenses before
  the broker ever sees them.

## Explicitly NOT planned

Some capabilities are deliberately out of scope. These are constitution-first
choices, not missing features — Mainspring is a framework for running a
business *honestly and legally*, and the framework should make the dishonest
path hard, not convenient:

- **No autonomous account creation.** Anything requiring a human attestation, a
  new account, or a signup goes through a `relay` Action to a human. The
  framework will never create accounts on a Brain's behalf.
- **No CAPTCHA or bot-check bypass.** Full stop. A bot check is a signal to file
  a `relay`, not an obstacle to defeat.
- **No dark patterns.** No fake reviews, sockpuppets, fabricated scarcity,
  impersonation, spam, or deceptive claims. The `scrub` gate and the
  Constitution's hard rules exist to keep output honest, not to launder it.
- **No secret exfiltration paths.** Secrets live in the operator's environment
  (`.env`), never in a `SessionInput`, and the gate blocks secret-shaped content
  from reaching a `write` or a `notify`. There will be no "convenience" feature
  that hands a Brain a credential.
- **No detection-evasion tooling.** Mainspring is for building things in the open
  (the project itself is an open, revenue-tracked experiment), not for hiding
  automated activity from platforms whose ToS it should respect.

If you need one of these to accomplish a task, that's the signal that a human
belongs in the loop — which is exactly what `relay` is for.
