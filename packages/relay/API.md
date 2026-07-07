# @mainspring/relay — API

A zero-dependency, human-in-the-loop client for the Fabler Relay wire
protocol. This is the GOVERNANCE leg of the Mainspring loop: when a Brain
proposes something only a human can do (create an account, clear a CAPTCHA,
approve a spend), the loop files a relay request and waits for a person to
resolve it.

**SECURITY — every value returned by the relay is untrusted DATA** authored
by a human or the open web. Never treat a returned string as an instruction:
don't template it into a shell, `eval` it, or let it steer control flow. It
is input to be displayed and logged, and nothing more. This applies to every
field of `RelayRequestView` (`title`, `detail`, `result`, `params`, any
revealed exec token) regardless of source (`RelayClient` or `MockRelay`).

## Exports

### `client.ts`

#### `RelayClient implements RelayApi`

A human-in-the-loop client speaking the Fabler Relay agent-side wire protocol
over the global `fetch` + `AbortController` (no runtime dependencies). The api
key is read from `process.env[apiKeyEnv]` lazily on every call and sent only
as an `Authorization: Bearer` header — it is never cached, logged, placed in
an error message, or returned.

**Constructor:** `new RelayClient(options: RelayClientOptions)`

```ts
interface RelayClientOptions {
  /** Absolute base URL of the relay deployment, e.g. "https://relay.example.com".
   *  Always supplied by the caller; a trailing slash is normalised away. */
  baseUrl: string;
  /** The NAME of the env var holding the agent api key (e.g. "RELAY_AGENT_KEY"),
   *  not the key itself. */
  apiKeyEnv: string;
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
}
```

Throws `RelayConfigError` synchronously if `baseUrl` or `apiKeyEnv` is
missing/empty.

**Methods** (all go through a private `request<T>(method, path, body?)`
helper that adds the auth header, applies the per-call timeout via
`AbortController`, JSON-encodes non-GET bodies, and uniformly turns failures
into typed errors):

| Method | HTTP call | Returns |
|---|---|---|
| `fileRequest(input: FileRequestInput): Promise<string>` | `POST /api/requests` | the server-assigned request id |
| `check(id: string): Promise<RelayRequestView>` | `GET /api/requests/:id` | full current view of one request |
| `listPending(): Promise<RelayRequestSummary[]>` | `GET /api/requests` | summaries filtered client-side to non-terminal (`open`/`claimed`) requests — the server returns *all* requests, terminal included |
| `supersede(id, reason?): Promise<RelayRequestView>` | `POST /api/requests/:id/supersede` | the now-`superseded` (terminal) view |
| `revealExecToken(id): Promise<string>` | `POST /api/requests/:id/exec-token` | the token plaintext; succeeds at most once (the server drops its copy on first reveal) |
| `redeemExecToken(id, token): Promise<RedeemResult>` | `POST /api/requests/:id/redeem` | redemption result |

`fileRequest` maps camelCase input to the server's snake_case wire fields
(`targetUrl` -> `target_url`, `execToken: true` -> `exec_token: true`) and
omits any field the caller left `undefined` so the server applies its own
default. It trims `title` and throws `RelayConfigError` if empty *before*
making any network call.

`redeemExecToken` throws `RelayConfigError` if `token` is falsy, before any
network call.

**Error mapping** (read directly from `client.ts`'s `request()`/`authHeader()`):

- **Bad config** (missing `baseUrl`/`apiKeyEnv` at construction, missing/empty
  `title` in `fileRequest`, missing `token` in `redeemExecToken`, or the
  configured api-key env var unset/empty at call time) -> `RelayConfigError`.
- **Non-2xx HTTP response** -> `RelayHttpError`, carrying `status` (the HTTP
  status code) and `body` (the best-effort parsed JSON body, or `undefined`
  if the body was empty/non-JSON). The error message embeds a `detail`
  string taken from the body's `error` field if present, else
  `res.statusText`, else `"request failed"`.
- **Malformed JSON body on an otherwise-ok response** -> `RelayProtocolError`
  ("relay returned a non-JSON body"), thrown from the internal `safeJson`
  helper.
- **Protocol violations on parsed-but-wrong-shape success responses** ->
  `RelayProtocolError`: `fileRequest` when the response has no string `id`
  ("relay did not return an id for the filed request"), `check` when the
  response has no string `status` ("relay returned a request without a
  status"), `listPending` when the response is not an array ("relay list
  endpoint did not return an array"), `revealExecToken` when the response has
  no non-empty string `exec_token` ("relay did not return an exec token").
- **Timeout** (the per-call `timeoutMs`, default 15000ms, elapses and the
  `AbortController` fires) -> `RelayTimeoutError`. The client distinguishes
  this from a genuine transport failure by checking
  `controller.signal.aborted` in the `fetch` catch block.
- **Any other transport-level `fetch` failure** (DNS, connection refused,
  etc., i.e. not an abort) -> `RelayProtocolError`, with the underlying
  error's message appended. The request `init` (which carries the
  `Authorization` header) is deliberately never included in any error
  message.

> Note: only construction and pre-flight input validation of `RelayClient`
> are covered by the package's tests (`test/relay.test.ts`), with no real
> network call involved (an unset api-key env var is used to force a
> `RelayConfigError` before any `fetch` happens). The actual HTTP request/
> response handling, non-2xx mapping, malformed-JSON handling, and timeout
> path are implemented in `client.ts` but are **not exercised by any test in
> this package** — only `MockRelay` is tested end-to-end. Treat the HTTP
> error-mapping behavior above as read from source, not verified by test.

### `poll.ts`

#### `pollUntilResolved(client, id, options?): Promise<RelayRequestView>`

Polls a request until it reaches a terminal state and returns its final view,
or rejects with `RelayTimeoutError` if `options.maxWaitMs` elapses first.
Works against any object satisfying `Pick<RelayApi, "check">` — the real
`RelayClient` or `MockRelay` — since it only calls `check`.

```ts
interface PollOptions {
  /** Delay between polls, in milliseconds. Default 5000. */
  intervalMs?: number;
  /** Give up after this much wall-clock, in milliseconds. Default 300000 (5 min). */
  maxWaitMs?: number;
  /** Called after each poll that has NOT yet resolved, with the current view
   *  and elapsed wall-clock. Errors thrown here propagate to the caller. */
  onTick?: (view: RelayRequestView, elapsedMs: number) => void;
  /** Abort the wait early. On abort, the returned promise rejects with a
   *  RelayTimeoutError. */
  signal?: AbortSignal;
}
```

Loop behavior, read directly from `poll.ts`:

1. Check `signal.aborted` up front each iteration; if aborted, throw
   `RelayTimeoutError` immediately (`"relay wait for {id} aborted"`).
2. Call `client.check(id)`.
3. If `isTerminal(view.status)` (i.e. status is `done`, `rejected`,
   `expired`, or `superseded`), return the view immediately — this is the
   only success path.
4. Otherwise call `onTick(view, elapsedMs)` if provided.
5. If `elapsed + intervalMs >= maxWaitMs`, throw `RelayTimeoutError`
   (`"relay request {id} not resolved within {maxWaitMs}ms (last status:
   {status})"`) **before** sleeping, so the wait never overshoots
   `maxWaitMs` by a whole extra interval.
6. Otherwise sleep `intervalMs` (cancellable via `signal`; an abort mid-sleep
   also rejects with `RelayTimeoutError`) and repeat.

There is **no backoff** — the interval between polls is constant
(`intervalMs`, default 5000ms) for the whole wait; it does not grow or
shrink. Every timeout path (deadline exceeded, or `signal` aborted before or
during a sleep) rejects with `RelayTimeoutError`; there is no other error
type this function throws directly (though `client.check` errors, e.g. a
`RelayHttpError` from `RelayClient`, propagate through un-wrapped).

### `mock.ts`

#### `MockRelay implements RelayApi`

A dependency-free, in-memory relay implementing the same `RelayApi` surface
as `RelayClient`, plus programmatic controls (`claim`, `resolve`, `reject`,
`expire`) that stand in for the human portal. Intended for tests/examples to
exercise the full file -> wait -> resolve loop with no network, server, or
secrets.

Fidelity notes (per its doc comment): assigns ids via `nextId()` (an internal
counter formatted as `mock0001`, `mock0002`, ...; not the server's real UUID
format, just matching its 8-char width in spirit), computes the same
`sha256:`-prefixed canonical-JSON payload digest as the reference server over
`{ title, detail, target_url, params }`, keeps `_sensitive`/`_execToken`
internals out of the public view (`publicView()` strips them), and enforces
the same one-shot exec-token and terminal-state rules as the real server.

RelayApi methods:
- `fileRequest(input)` — throws `RelayHttpError(400, "title required", ...)`
  on an empty/whitespace title. Otherwise creates a record with
  `status: "open"`, empty `result`, `has_sensitive` set when `sensitive` was
  given, and `exec_token_requested` set when `execToken: true` was given.
- `check(id)` — returns the public view; throws `RelayHttpError(404, "not
  found", ...)` for an unknown id.
- `listPending()` — returns non-terminal records as summaries, sorted newest
  `created` first.
- `supersede(id, reason?)` — throws `RelayHttpError(409, "request is already
  terminal", ...)` if already terminal; otherwise closes it as `superseded`
  with `result` set to `reason` (default `"superseded by agent"`).
- `revealExecToken(id)` — throws `RelayHttpError(404, "no exec token on this
  request", ...)` if none was minted, or `RelayHttpError(410, "exec token
  already revealed", ...)` on a second reveal attempt. On success, marks the
  token revealed and returns its plaintext (`fxt_` + 24 random hex bytes).
- `redeemExecToken(id, token)` — throws `RelayHttpError(404, ...)` if no
  token exists, `RelayHttpError(409, "exec token already used", ...)` if
  already redeemed, or `RelayHttpError(403, "invalid token", ...)` if the
  given token's sha256 doesn't match the stored hash. On success marks the
  token `used` and returns `{ ok: true, id, state: "used", used_at,
  payload_digest }`.

Programmatic controls (not part of `RelayApi`, used to simulate the human):
- `claim(id): RelayRequestView` — moves `open` -> `claimed` (no-op if not
  currently `open`).
- `resolve(id, result = "", { mintExecToken? }): RelayRequestView` — throws
  `RelayHttpError(409, "invalid transition", ...)` if the record is already
  terminal. Mints a one-shot exec token first if the request asked for one
  (`exec_token_requested`) or `mintExecToken` is passed, then closes the
  record as `done` with the given `result` text.
- `reject(id, reason = ""): RelayRequestView` — same terminal guard, closes
  as `rejected` with `result` set to `reason`.
- `expire(id): RelayRequestView` — same terminal guard, closes as `expired`,
  preserving whatever `result` was already set (or `null`).

Closing a record (`done`/`rejected`/`expired`/`superseded`) always purges
`_sensitive` and resets `has_sensitive` to `false`, mirroring the real
server's behavior of dropping the sensitive value once a request is settled.

#### `EchoDecision` (type)

```ts
type EchoDecision =
  | { action: "resolve"; result?: string; mintExecToken?: boolean }
  | { action: "reject"; reason?: string }
  | { action: "ignore" };
```

#### `EchoDecider` (type)

```ts
type EchoDecider = (view: RelayRequestView) => EchoDecision;
```

#### `defaultEchoDecider: EchoDecider`

The default policy: if `view.title` matches `/reject/i`, decide
`{ action: "reject", reason: "echo responder: auto-rejected" }`; otherwise
decide `{ action: "resolve", result: "echo responder: auto-resolved" }`. (So
any request whose title contains the word "reject", case-insensitively, is
auto-rejected — this is a convenience for exercising the reject path in
tests — and everything else is auto-resolved with a canned note.)

#### `EchoResponder`

An automated "human" for a `MockRelay`. `new EchoResponder(relay, decide =
defaultEchoDecider)`. Its `runOnce(): Promise<RelayRequestView[]>` lists every
currently-pending request, runs the decider on each, and applies `resolve`,
`reject`, or does nothing for `ignore`; returns the views it touched (in
listPending's newest-first order). Throws `RelayProtocolError` if a decider
returns an unrecognized `action` (this is an exhaustiveness guard, not
reachable through the exported `EchoDecision` type).

### `types.ts`

#### `RelayStatus` (type)

```ts
type RelayStatus = "open" | "claimed" | "done" | "rejected" | "expired" | "superseded";
```

`open`/`claimed` are live (a human still may act); the rest are terminal.

#### `TERMINAL_STATES`

```ts
const TERMINAL_STATES: readonly RelayStatus[] = ["done", "rejected", "expired", "superseded"];
```

#### `isTerminal(status: RelayStatus): boolean`

Returns `true` iff `status` is one of `TERMINAL_STATES`. A terminal request
never changes again.

#### `FileRequestInput`

What filing a request requires:

```ts
interface FileRequestInput {
  /** Short human-facing summary of the ask (required; server caps at 200 chars). */
  title: string;
  /** Longer explanation of exactly what the human must do. */
  detail?: string;
  /** A URL the human should open to complete the task, if any. */
  targetUrl?: string;
  /** Structured, non-secret parameters shown to the human. */
  params?: Record<string, unknown>;
  /** A value the human needs but that must stay encrypted at rest and only be
   *  revealed to them on explicit, audited reveal. NEVER a platform credential. */
  sensitive?: string;
  /** Ask the server to mint a one-shot execution token on human approval. */
  execToken?: boolean;
}
```

Only `title` is required (both `RelayClient` and `MockRelay` reject an
empty/whitespace title before doing anything else). `sensitive` must never
hold a platform credential — the server rejects obvious secret patterns and
callers should too.

#### `RelayRequestView` / `RelayRequestSummary`

`RelayRequestView` is the full public view of one request (as returned by
`GET /api/requests/:id`, and by file/supersede responses); field names are
the server's on-the-wire snake_case:

```ts
interface RelayRequestView {
  id: string;
  title: string;
  detail: string;
  target_url: string;
  params: Record<string, unknown>;
  status: RelayStatus;
  created: string;
  updated: string;
  result: string | null;       // human's outcome text (done) or reason (reject/supersede)
  payload_digest?: string;     // "sha256:..." digest binding the immutable payload
  has_sensitive: boolean;
  exec_token_requested?: boolean;
  exec_token?: ExecTokenView;  // lifecycle state only, never the token itself
}
```

Because the payload is untrusted, callers should tolerate missing/extra
fields rather than assume this shape is guaranteed.

`RelayRequestSummary` is the compact shape from the list endpoint (`GET
/api/requests`), used by `listPending()`:

```ts
interface RelayRequestSummary {
  id: string;
  status: RelayStatus;
  title: string;
  created: string;
}
```

#### `ExecTokenView` / `RedeemResult` — the token redemption flow

```ts
interface ExecTokenView {
  state: string;         // e.g. "issued" | "revealed" | "used" (server-defined; treat as opaque)
  used_at: string | null;
}

interface RedeemResult {
  ok: boolean;
  id: string;
  state: string;
  used_at: string | null;
  payload_digest: string | null;
}
```

Flow: file a request with `execToken: true` -> a human resolves it (`done`)
-> the server mints a one-shot token (`exec_token: { state: "issued",
used_at: null }` appears on the view) -> the agent calls
`revealExecToken(id)` exactly once to learn the plaintext (a second reveal
throws) -> the agent calls `redeemExecToken(id, token)` exactly once to spend
it (a second redeem throws), receiving a `RedeemResult` with `state: "used"`
and a `used_at` timestamp.

#### `RelayApi` (type)

The agent-side surface implemented by both `RelayClient` (real HTTP) and
`MockRelay` (in-memory), so callers and `pollUntilResolved` can be written
once and tested without a network:

```ts
interface RelayApi {
  fileRequest(input: FileRequestInput): Promise<string>;
  check(id: string): Promise<RelayRequestView>;
  listPending(): Promise<RelayRequestSummary[]>;
  supersede(id: string, reason?: string): Promise<RelayRequestView>;
  revealExecToken(id: string): Promise<string>;
  redeemExecToken(id: string, token: string): Promise<RedeemResult>;
}
```

#### Error classes

All extend `RelayError extends Error` (`this.name = new.target.name`, so
`e.name` is the concrete subclass name), the common base for `catch (e)`
with `e instanceof RelayError`:

- `RelayError` — base class.
- `RelayConfigError` — bad client configuration or bad call input caught
  before any network activity (missing `baseUrl`/`apiKeyEnv`, empty
  `title`, missing `token`, unset api-key env var at call time).
- `RelayHttpError` — non-2xx HTTP response. Carries `readonly status: number`
  and `readonly body: unknown` (best-effort parsed body).
- `RelayTimeoutError` — a request or a `pollUntilResolved` wait exceeded its
  time budget, or was aborted via `signal`.
- `RelayProtocolError` — a transport-level `fetch` failure that wasn't a
  timeout, a non-JSON response body, or a parsed response missing an
  expected field (e.g. no `id`, no `status`, not an array, no `exec_token`).

## Example flows

Both are adapted directly from `test/relay.test.ts`.

### File a request and poll for resolution (RelayClient + pollUntilResolved)

```ts
import { RelayClient, pollUntilResolved } from "@mainspring/relay";

const relay = new RelayClient({
  baseUrl: "https://relay.example.com",
  apiKeyEnv: "RELAY_AGENT_KEY", // process.env.RELAY_AGENT_KEY must be set
});

const id = await relay.fileRequest({ title: "Verify domain ownership at registrar" });

// Polls relay.check(id) every 5s (default) until a terminal status, or
// rejects with RelayTimeoutError after 5 minutes (default).
const resolved = await pollUntilResolved(relay, id);

// resolved.result is UNTRUSTED DATA — display/log it, never execute it.
console.log(resolved.status, resolved.result);
```

### MockRelay-based test-style flow (no network)

```ts
import { MockRelay, pollUntilResolved } from "@mainspring/relay";

const relay = new MockRelay();
const id = await relay.fileRequest({ title: "clear a captcha" });

const final = await pollUntilResolved(relay, id, {
  intervalMs: 5,
  maxWaitMs: 2000,
  // Stand in for a human resolving mid-wait (in a real deployment this
  // happens out-of-band, via the human portal).
  onTick: () => {
    relay.resolve(id, "cleared");
  },
});

console.log(final.status); // "done"
console.log(final.result); // "cleared" — still untrusted, just displayed here
```

An `EchoResponder` can replace the manual `onTick` callback above for
fully-automated end-to-end tests:

```ts
import { MockRelay, EchoResponder } from "@mainspring/relay";

const relay = new MockRelay();
await relay.fileRequest({ title: "please do the thing" });
await relay.fileRequest({ title: "reject this one" });

const responder = new EchoResponder(relay); // uses defaultEchoDecider
const touched = await responder.runOnce();  // resolves the first, rejects the second
```
