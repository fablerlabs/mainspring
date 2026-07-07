# Good first issues

Real, small, verified gaps in the current codebase — each one checked by
reading the cited source and test files, not guessed at. Pick one, open a
PR against it (see `CONTRIBUTING.md` for setup and expectations), and feel
free to file a question as a draft PR or a GitHub issue if anything below
turns out to be stale by the time you read it.

See also `docs/roadmap.md` → "Want to help?" and `docs/issue-drafts/` for
larger, more open-ended gaps (a new Brain adapter, a scheduled example, a
storage-abstraction design discussion) — this file is just the small ones.

---

## 1. Add the missing `@mainspring/broker` and `@mainspring/schedule` rows to the README package table

**Where:** `README.md`, the package table starting at line 47 (`| Package | Purpose | Status |`).

**What's wrong:** The table lists `core`, `cli`, `memory`, `scrub`, `relay`,
`ledger`, `governance`, and `brains` — but not `packages/broker` or
`packages/schedule`, both of which exist, build, and have passing test
suites (13/13 and 20/20 respectively as of this writing). Verified with
`grep -n "broker\|schedule" README.md`, which returns nothing.

**Acceptance:** Two new rows added, matching the existing table's format
(package link, one-line purpose, honest status — see `docs/roadmap.md`'s
"Shipped" section for accurate wording to draw from for each package's
current status).

**Effort:** trivial, docs-only.

---

## 2. Test `ClaudeBrain.step()`'s non-2xx error branch

**Where:** `packages/brains/src/claude.ts`, lines 235–241 (the `if
(!res.ok)` branch inside `step()`). Existing tests: `packages/brains/test/brains.test.ts`.

**What's wrong:** Every `.step(` call in `brains.test.ts` exercises
`MockBrain`; there is no test that drives `ClaudeBrain.step()` against a
non-200 response. Verified by reading the full test file — `ClaudeBrain`
is only tested for construction (`apiKey` validation) and `estimateCost`
(lines 192–201), plus the pure `buildClaudeRequest`/`parseClaudeResponse`
helpers. The error-throwing branch that reads `res.text()` and includes it
in the thrown message has zero coverage.

**Acceptance:** A test that stubs the global `fetch` (e.g. reassign
`globalThis.fetch` for the duration of the test, restoring it after) to
return a non-ok `Response`-shaped object, and asserts `step()` rejects with
an `Error` whose message includes the status code and the body detail.

**Effort:** small — the tricky part is finding a clean way to stub `fetch`
without a mocking library (this repo has zero test-only dependencies
either); a plain object matching the subset of the `Response` shape
`claude.ts` actually reads (`.ok`, `.status`, `.statusText`, `.text()`,
`.json()`) is enough.

---

## 3. Test `scanFiles()` in `@mainspring/scrub`

**Where:** `packages/scrub/src/scan.ts`, lines 60–69. Existing tests:
`packages/scrub/test/scrub.test.ts` and `redteam2.test.ts`.

**What's wrong:** `scan()` (string-in, findings-out) is exhaustively
tested — every pattern class, redaction, entropy heuristic, line
numbering. `scanFiles()`, the only function in the package that touches
the filesystem (`readFile` per path, tagging each finding with `file`), is
exported from `packages/scrub/src/index.ts` but never referenced in either
test file — verified with `grep -n "scanFiles" packages/scrub/src/scan.ts
packages/scrub/test/*.ts`, which shows the one definition site and no test
call sites.

**Acceptance:** A test (using a temp directory, following the
`mkdtemp`/`writeFile` pattern already used in `packages/memory`'s and
`packages/ledger`'s tests) that scans 2+ real files and asserts: findings
carry the correct `file` path per source file, line numbers are per-file
(not cumulative across files), and a custom `opts.patterns` is honored
just like it is in `scan()`.

**Effort:** small, test-only.

---

## 4. Test `RelayClient`'s real HTTP path

**Where:** `packages/relay/src/client.ts`, the private `request()` method
(lines 169–207) that every public method (`fileRequest`, `check`,
`listPending`, `supersede`, `revealExecToken`, `redeemExecToken`) funnels
through.

**What's wrong:** `relay.test.ts`'s only `RelayClient` test
("`RelayClient` validates its construction and inputs without any
network") covers construction and pre-flight input validation. The actual
`fetch` call, the `RelayHttpError` path (non-ok response with a JSON
`{error: "..."}` body), the `RelayProtocolError` paths (non-JSON 2xx body;
a filed request missing its `id`), and the `RelayTimeoutError` path
(abort-on-timeout) are all unexercised — verified by reading the full test
file, which has no `fetch` stubbing at all.

**Acceptance:** Tests that stub `globalThis.fetch` (same technique as
issue #2 above — the two could reasonably share a tiny helper, though
there isn't one today) to cover: a successful `fileRequest` parsing the
returned `id`, a non-ok response producing `RelayHttpError` with the
right `status`, a non-JSON 2xx body producing `RelayProtocolError`, and a
`fileRequest` response missing `id` producing `RelayProtocolError`. A
timeout test is a stretch goal — it needs a `fetch` stub that never
resolves and a short `timeoutMs`.

**Effort:** medium — the most involved item here, since it means writing
the repo's first `fetch`-stubbing helper, but it's the single biggest
untested surface in `packages/relay`.

---

## 5. Test `checkSpend()` with a negative `amountUsd`

**Where:** `packages/ledger/src/caps.ts`, `checkSpend()` (lines 35–39).
Existing tests: `packages/ledger/test/ledger.test.ts`, lines 144–170.

**What's wrong:** The boundary tests are thorough (exactly
`autoApproveUnder`, exactly `approvalCodeOver`, a custom policy) but every
value tested is `>= 0`. A negative `amountUsd` (e.g. representing a
refund) currently falls through to `"proceed"` since it's below every
threshold — that's plausibly the right behavior, but it's currently an
accident of the `>=` chain rather than a decision anyone made on purpose.
Verified by reading `caps.ts` in full and every `checkSpend(` call site in
the test file — none pass a negative number.

**Acceptance:** A test asserting `checkSpend(-10)` (and similar) returns
`"proceed"`, plus a one-line doc comment on `checkSpend` noting that
negative amounts (refunds/credits) are intentionally treated as
always-proceed, not just untested. If a maintainer decides negative
amounts should instead be rejected before reaching `checkSpend`, that's a
legitimate alternative outcome for this issue to land on — either way it
stops being silent.

**Effort:** trivial — the smallest task on this list, a good literal
first PR.

---

## 6. Add an example that exercises `@mainspring/schedule`

**Where:** new `examples/scheduled-business/`, following the shape of
`examples/quickstart` or `examples/hello-business`.

**What's wrong:** No example or package in `examples/` imports
`@mainspring/schedule` — verified with `grep -rn "@mainspring/schedule"
examples/`, zero hits. The package itself (cadence checks, backoff on
consecutive failures, `STOP`-file handling) is well tested standalone
(`packages/schedule/test/`), but nothing in the repo shows a workspace
actually wiring it into a run loop, so a new contributor has no worked
example to copy from.

**Acceptance:** A runnable example workspace demonstrating: a session
that's skipped when called before its configured cadence, backoff
lengthening the wait after consecutive failures and resetting on success,
and a `STOP` file short-circuiting a run before anything else executes.
See `docs/issue-drafts/04-schedule-example.md` for the full drafted issue
(this entry is the condensed, good-first-issue-sized pointer to it).

**Effort:** medium/large — the most substantial item here; a good second
or third PR rather than a first one, but still self-contained to one new
directory.
