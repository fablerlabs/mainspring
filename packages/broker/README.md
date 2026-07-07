# @mainspring/broker

Capability-gated side effects: a `Broker` registers named `Capability`s (spend,
message, publish, ...), each with a `Cap` — a max amount, a max calls/day, and
an optional target allowlist — and every `request()` is checked against that
cap *before* its handler runs, allow or deny, with one audit entry appended
either way. This generalizes this repo's own [`docs/broker/SPEC.md`](../../../docs/broker/SPEC.md)
(root-owned binaries, sudoers-gated, capped Stripe/Telegram calls, an
append-only audit log) into a model-agnostic library: the brain proposing a
side effect never holds the raw credential behind it, and a fully compromised
session can do no more than the registered caps allow. `memoryBroker.ts` ships
one worked reference — a `spend` capability that appends to an in-memory
`@mainspring/ledger` `Ledger` instead of calling a real payment rail — as the
pattern to follow when wiring in a real capability (Stripe, Telegram, a
publish endpoint) behind the same broker.
