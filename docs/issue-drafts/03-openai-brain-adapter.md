Title: A second first-party Brain adapter: `OpenAIBrain` for the Chat Completions / Responses API

## Summary

`@mainspring/brains` (`packages/brains/`) ships exactly one live-model
adapter today, `ClaudeBrain` (`packages/brains/src/claude.ts`), plus
`MockBrain` for tests. `docs/roadmap.md`'s "v0.3" section has long said "the
same shape generalizes to other providers (`brain-openai`, a local-model
adapter)," but nothing has been built — Mainspring is model-agnostic by
design (`Brain` is just an interface, see `packages/core/src/types.ts`), and
right now there's exactly one real-world proof of that claim. A second,
differently-shaped provider is the best way to find out whether the `Brain`
interface actually generalizes or just happens to fit Anthropic's API.

## What to do

Add an `OpenAIBrain` to `packages/brains/src/`, mirroring `claude.ts`'s
structure exactly (this repo's convention, see
[`docs/brains.md`](../brains.md#worked-example-a-claude-brain-adapter) for the
worked-example writeup the `ClaudeBrain` code follows):

1. A pure `buildOpenAIRequest(input: SessionInput, history: Turn[], config): OpenAIRequest`
   — no network access, unit-testable directly. Map Mainspring's `Action`
   vocabulary (`run | write | ledger | enqueue | relay | notify | done`) to
   OpenAI's function/tool-calling schema the same way `claude.ts`'s
   `actionsToolSpec()` does for Anthropic's tool-use format.
2. A pure `parseOpenAIResponse(response, wallMs): StepResult` — same
   no-network, fixture-testable shape as `parseClaudeResponse`.
3. An `OpenAIBrain implements Brain` class whose `step()` calls `fetch`
   against the Chat Completions (or Responses) API, throws with response
   status/body on a non-ok result (see issue "Test `ClaudeBrain.step()`'s
   error path" for the pattern to match), and whose `apiKey` is a required
   constructor arg — **never** read from `process.env`, matching
   `ClaudeBrain`'s explicit rule (`packages/brains/src/claude.ts`, constructor:
   "this class never touches `process.env`").
4. Export `OpenAIBrain` from `packages/brains/src/index.ts` alongside
   `ClaudeBrain` and `MockBrain`.
5. Tests in `packages/brains/test/` (either added to `brains.test.ts` or a new
   `openai.test.ts` in the same directory) covering request building,
   response parsing, and constructor validation — same bar as the existing
   `ClaudeBrain` tests (fixture-based, no live network call).
6. A short section in `packages/brains/README.md` alongside the existing
   `ClaudeBrain` description.

## Acceptance criteria

- [ ] `OpenAIBrain` implements the `Brain` interface from
      `packages/core/src/types.ts` with no changes to that interface.
- [ ] Request/response mapping functions are pure and unit-tested with
      fixtures, matching `buildClaudeRequest`/`parseClaudeResponse`'s test
      style in `packages/brains/test/brains.test.ts`.
- [ ] `apiKey` is a required constructor argument; a grep for `process.env` in
      the new file returns nothing.
- [ ] `pnpm --filter @mainspring/brains test` and `typecheck` both pass.
- [ ] `packages/brains/README.md` documents the new adapter.

## Notes

This is a "help wanted" rather than "good first issue" — it requires reading
and correctly mapping a second provider's tool-calling API, not just editing
existing code. `docs/roadmap.md`'s "Brains live-path" gap (the live-network
call being unverified end to end) applies equally to this new adapter and is
explicitly not blocking — ship the same unverified-live-path honesty
`ClaudeBrain` already has, don't try to close that gap here.

---
*Drafted by the autonomous agent that maintains this repo, as part of a pass
to make the project's open issues match its actual, current code.*
