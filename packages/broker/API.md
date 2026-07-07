# @mainspring/broker API

Capability-gated side effects: spend/message/publish requests are checked against
per-capability caps and audited, allow or deny, before anything happens. A
`Broker` registers named `Capability`s (each with a `Cap` — a max amount, a max
calls/day, and an optional target allowlist), and every `Broker#request` is
checked against that cap *before* its handler runs, fails closed on any
violation, and appends exactly one audit entry either way. `memoryBroker.ts`
ships one worked reference capability, `spend`, wired to an in-memory
`@mainspring/ledger` `Ledger` instead of a real payment rail — the pattern to
follow when wiring in a real capability (Stripe, Telegram, a publish endpoint)
behind the same broker.

## Exports

### `broker.ts`

#### `class Broker`

```ts
constructor(options: { clock?: () => Date } = {})
```

- `options.clock` — optional injectable clock, defaults to `() => new Date()`. Used for both the audit `timestamp` and for computing the UTC day key that `maxCallsPerDay` resets on. Tests use a fixed or mutable clock to exercise cap-reset behavior deterministically.

```ts
register(capability: Capability, handler: CapabilityHandler): void
```

- Registers one capability's `Cap` and handler under `capability.id`.
- **Throws** `Error("capability already registered: <id>")` if `capability.id` is already registered. This is the only method that throws in normal use — capabilities are fixed at wiring time, not re-defined mid-run.

```ts
get audit(): readonly AuditEntry[]
```

- Returns the full audit trail so far, oldest first, as a **frozen copy** (`Object.freeze` of a `.slice()`). Mutating the returned array throws (it's frozen) and, regardless, cannot affect the broker's own internal record.

```ts
async request(req: BrokerRequest): Promise<BrokerResult>
```

- Checks `req` against its capability's `Cap` and, only if every check passes, calls the registered handler. **Always returns a `BrokerResult`; never throws** — even a handler that throws is caught internally and turned into a denied result (see below). Exactly one `AuditEntry` is appended per call, whatever the outcome.
- Order of checks, each one short-circuiting to a deny with no handler call:
  1. **Unknown capability** — `req.capability` was never `register`ed → denied with reason `` unknown capability: <req.capability> ``.
  2. **Allowlist** — if `cap.allowlist` is set, `req.target` must be present in it. An omitted `target` against an allowlisted capability is a deny, not a wildcard → reason `` target "<target>" not on allowlist for capability "<id>" `` (or `(none given)` if `target` is `undefined`).
  3. **Max amount** — if `cap.maxAmountUsd` is set and `req.amountUsd` is set, `req.amountUsd > cap.maxAmountUsd` denies → reason `` amountUsd <n> exceeds cap <max> for capability "<id>" ``. (If either is `undefined` this check is skipped — an amount cap does not implicitly require `amountUsd` on the request; a handler is free to require it itself, as `memoryBroker`'s `spend` handler does.)
  4. **Daily call cap** — the count of *serviced* (checks-passed) requests for this capability on the current UTC day (`dayKey`, `YYYY-MM-DD` from `now.toISOString().slice(0, 10)`) must be `< cap.maxCallsPerDay`, else denied → reason `` daily call cap (<max>) reached for capability "<id>" ``. A **denied** request (steps 1-3, or reaching this cap itself) does **not** increment the day's count. The day boundary is exactly the UTC calendar day of the injected clock — there is no timezone other than UTC and no rolling window.
  5. If all checks pass, the day's count is incremented (this call's 1-based index is `callIndexToday`) *before* the handler runs, then `handler(req)` is awaited.
     - Handler resolves → recorded as `allowed: true, reason: "ok"`, returns `{ allowed: true, reason: "ok", output: <handler's return value> }`.
     - Handler throws (sync or rejects) → recorded as `allowed: false`, reason `` handler threw: <error message> ``, returns `{ allowed: false, reason }` with no `output`. This attempt **still counts against the day's cap** — it was authorized to run, so its `callIndexToday` is still recorded in the audit entry.
- `AuditEntry` fields written on every call: `timestamp` (`now.toISOString()`), `capability`, `op`, `target`, `amountUsd` (copied verbatim from `req`), `allowed`, `reason`, `dayKey`, and `callIndexToday` (the 1-based count for that capability/day, present only when the request reached step 5 — i.e. `undefined` for anything denied in steps 1-4).

```ts
// registering a capability and driving it through Broker#request
import { Broker } from "@mainspring/broker";

const broker = new Broker({ clock: () => new Date("2026-07-07T10:00:00.000Z") });

broker.register(
  {
    id: "notify-owner",
    description: "Send a short message to the fixed owner chat id.",
    cap: { maxCallsPerDay: 2, allowlist: ["owner-chat-id"] },
  },
  (req) => ({ echoed: req.op }),
);

// denied: target not on the allowlist, handler never called
await broker.request({ capability: "notify-owner", op: "spam", target: "attacker" });
// => { allowed: false, reason: 'target "attacker" not on allowlist for capability "notify-owner"' }

// allowed: target matches the allowlist
const result = await broker.request({ capability: "notify-owner", op: "send", target: "owner-chat-id" });
// => { allowed: true, reason: "ok", output: { echoed: "send" } }

broker.audit; // frozen array of both AuditEntry rows, in call order
```

### `memoryBroker.ts`

#### `DEFAULT_SPEND_CAP: Cap`

```ts
export const DEFAULT_SPEND_CAP: Cap = { maxAmountUsd: 75, maxCallsPerDay: 10 };
```

Mirrors the constitution's default expense guardrail: a notify-band per-request amount ($75) and ten mutations per UTC day. No `allowlist`.

#### `interface MemoryBrokerOptions`

```ts
export interface MemoryBrokerOptions {
  spendCap?: Cap;
  clock?: () => Date;
}
```

- `spendCap` — overrides `DEFAULT_SPEND_CAP` for the sample `spend` capability.
- `clock` — forwarded to the underlying `Broker` and used for the ledger's own `date` field on each append.

#### `interface MemoryBroker`

```ts
export interface MemoryBroker {
  broker: Broker;
  ledger: Ledger;
}
```

- `broker` — the wired `Broker` instance with `spend` already registered.
- `ledger` — the in-memory `@mainspring/ledger` `Ledger` the `spend` capability appends to; inspect it directly in tests/demos, nothing else touches it.

#### `createMemoryBroker(options?: MemoryBrokerOptions): MemoryBroker`

Builds a `Broker` with one registered capability, `"spend"`, whose cap is `options.spendCap ?? DEFAULT_SPEND_CAP`. Its handler:

- **Throws** `Error('"spend" requires amountUsd')` if `req.amountUsd` is `undefined` — this happens *inside* the handler (after the cap checks pass), so per `Broker#request`'s fail-closed handling it surfaces as a denied result with reason `` handler threw: "spend" requires amountUsd `` and still consumes one call against the day's cap.
- Otherwise appends an `expense` entry to the internal `Ledger` (`date` from the clock, `description` set to `req.op`, `amountUsd` from `req.amountUsd`) and returns `{ balanceUsd: <new running balance> }` as the handler's output, which becomes `BrokerResult.output` on success.

```ts
// createMemoryBroker + its sample "spend" capability
import { createMemoryBroker } from "@mainspring/broker";

const { broker, ledger } = createMemoryBroker({
  clock: () => new Date("2026-07-07T00:00:00.000Z"),
});

const first = await broker.request({ capability: "spend", op: "vps-hosting", amountUsd: 20 });
// => { allowed: true, reason: "ok", output: { balanceUsd: -20 } }

const second = await broker.request({ capability: "spend", op: "domain", amountUsd: 12 });
// => { allowed: true, reason: "ok", output: { balanceUsd: -32 } }

ledger.balance();        // -32
ledger.entries.length;   // 2

// over the (default) $75 cap: denied, handler never runs, ledger untouched
await broker.request({ capability: "spend", op: "too-big", amountUsd: 100 });
// => { allowed: false, reason: "amountUsd 100 exceeds cap 75 for capability \"spend\"" }
```

### `types.ts`

#### `interface Cap`

```ts
export interface Cap {
  maxAmountUsd?: number;
  maxCallsPerDay: number;
  allowlist?: string[];
}
```

- `maxAmountUsd` — optional; a single request's `amountUsd` may not exceed this. Omit for capabilities with no dollar amount. If set but the request omits `amountUsd`, the amount check is skipped by the broker (a handler may still choose to require it, as `spend`'s does).
- `maxCallsPerDay` — required; requests actually serviced (all checks passed) may not exceed this many in one UTC calendar day.
- `allowlist` — optional; if set, a request must carry a `target` present in this list. Omitting `target` on a request against an allowlisted capability is a deny, not a wildcard.

#### `interface Capability`

```ts
export interface Capability {
  id: string;
  description: string;
  cap: Cap;
}
```

- `id` — unique within a `Broker` instance, e.g. `"spend"`, `"notify-owner"`.
- `description` — free-text description of the capability.
- `cap` — the `Cap` enforced on every request against this capability.

#### `interface BrokerRequest`

```ts
export interface BrokerRequest {
  capability: string;
  op: string;
  target?: string;
  amountUsd?: number;
  args?: Record<string, unknown>;
}
```

- `capability` — the registered `Capability.id` being invoked.
- `op` — a short label for what's being done, e.g. `"vps-hosting"` or `"product-create"`; carried into the audit log verbatim.
- `target` — the specific recipient/resource this request targets, checked against `Cap.allowlist` when the capability declares one.
- `amountUsd` — optional dollar amount, checked against `Cap.maxAmountUsd` when the capability declares one.
- `args` — optional free-form payload for the handler; the broker itself never reads or enforces anything on `args`.

#### `interface BrokerResult`

```ts
export interface BrokerResult {
  allowed: boolean;
  reason: string;
  output?: unknown;
}
```

- `allowed` — whether the request was authorized and its handler ran to completion without throwing.
- `reason` — `"ok"` on success, otherwise a specific deny reason (unknown capability, allowlist, amount, daily cap, or `` handler threw: <message> ``).
- `output` — the handler's return value; present only when `allowed` is `true`.

#### `interface AuditEntry`

```ts
export interface AuditEntry {
  timestamp: string;
  capability: string;
  op: string;
  target?: string;
  amountUsd?: number;
  allowed: boolean;
  reason: string;
  dayKey: string;
  callIndexToday?: number;
}
```

- `timestamp` — `now.toISOString()` at the moment of the request, from the broker's clock.
- `capability`, `op`, `target`, `amountUsd` — copied verbatim from the `BrokerRequest`.
- `allowed`, `reason` — same as on the returned `BrokerResult`.
- `dayKey` — the UTC calendar day (`YYYY-MM-DD`) the request fell on; the unit `Cap.maxCallsPerDay` resets on.
- `callIndexToday` — this capability's 1-based count of serviced requests on `dayKey`, including this one. `undefined` when the request was denied before being counted (unknown capability, allowlist, amount cap, or the daily cap itself).

Entries are pushed onto the broker's internal array via `Object.freeze(...)`, so each individual `AuditEntry` object is itself immutable, in addition to `Broker#audit` returning a frozen array.

#### `type CapabilityHandler`

```ts
export type CapabilityHandler = (req: BrokerRequest) => unknown | Promise<unknown>;
```

Handles one already-authorized request — called only after `Broker#request` has confirmed the request passes its capability's `Cap`. May be sync or async. Throwing (or a rejected promise) denies the `BrokerResult`, but the attempt is still audited and still counts against the day's cap, since it was authorized to run.
