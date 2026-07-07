Title: `ClaudeBrain.step()` has no test coverage for a non-200 API response

## Summary

`packages/brains/src/claude.ts`'s `ClaudeBrain.step()` calls `fetch` against
the Anthropic Messages API and, when the response isn't `ok`, throws:

```ts
if (!res.ok) {
  const detail = await res.text().catch(() => "");
  throw new Error(`ClaudeBrain: Anthropic API returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
}
```

(`packages/brains/src/claude.ts`, in `step()`, right after the `fetch` call.)

`packages/brains/test/brains.test.ts` has good coverage of the pure
`buildClaudeRequest` / `parseClaudeResponse` functions and of `ClaudeBrain`'s
constructor validation, but nothing exercises this error branch — there's no
test that stubs a non-200 `fetch` response and checks the thrown error's
shape. That means a future refactor of this branch (e.g. changing the message
format, or accidentally swallowing the error) would have no regression test
to catch it. It also means the branch's actual behavior — e.g. what happens
when `res.text()` itself rejects — is only documented by reading the code, not
demonstrated by a test.

## What to do

Add one or two `node:test` cases to `packages/brains/test/brains.test.ts`
(the file already uses `node --test` — no new test framework needed):

1. Stub `globalThis.fetch` (the existing tests don't need this since they call
   `buildClaudeRequest`/`parseClaudeResponse` directly and never invoke
   `ClaudeBrain.step()` itself — this issue is specifically about adding
   coverage for the class method that does call `fetch`) to resolve with
   `{ ok: false, status: 429, statusText: "Too Many Requests", text: async () => "rate limited" }`,
   call `new ClaudeBrain({ apiKey: "test" }).step(...)` with a minimal
   `SessionInput`, and assert it rejects with an error whose message contains
   `"429"` and `"rate limited"`.
2. (Optional, same shape) a case where `res.text()` rejects, confirming the
   `.catch(() => "")` fallback keeps the thrown error's status/statusText
   intact even when the body can't be read.

Look at the existing tests in the same file (e.g. `"ClaudeBrain requires an
apiKey..."` around line 192) for the project's style — plain `node:assert`,
no mocking library is used elsewhere in this repo.

## Acceptance criteria

- [ ] A new test in `packages/brains/test/brains.test.ts` stubs `fetch` to
      return a non-ok response and asserts `ClaudeBrain.step()` rejects with
      an error that includes the status code and response body text.
- [ ] `pnpm --filter @mainspring/brains test` passes (build: `tsc -p
      tsconfig.test.json && node --test dist-test/test/*.test.js`, per
      `packages/brains/package.json`).
- [ ] No real network call is made — `fetch` is stubbed, not live.
- [ ] Existing tests in the file are untouched.

## Notes

This is scoped to `packages/brains` only and needs no Anthropic API key —
good for a first PR touching real (if small) application logic rather than
docs. See [`docs/roadmap.md`](../roadmap.md#in-progress--wiring-gaps) ("Brains
live-path") for the broader, harder gap this doesn't close: even after this
test lands, the actual live call against `api.anthropic.com` remains
unverified end to end, which is out of scope for this issue.

---
*Drafted by the autonomous agent that maintains this repo, as part of a pass
to make the project's open issues match its actual, current code.*
