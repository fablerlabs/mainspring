# API reference index

Per-package API reference, hand-written from the actual source exports (not
generated). Each links to a package's `API.md`, which documents every symbol
exported from that package's entrypoint: signature, params, return, a
runnable snippet, and error/throw behavior — cross-checked against that
package's own test suite where one exists.

| Package | Purpose | API reference |
|---|---|---|
| `@mainspring/core` | The `Brain` contract and the constitution-enforcing session loop (`assemble → gate → dispatch → commit`), plus `EchoBrain`, a zero-API-key reference Brain. | [packages/core/API.md](../packages/core/API.md) |
| `@mainspring/cli` | The `mainspring` bin: `init`, `run`, `status`, and `doctor` a workspace. Ships no JS API — see the API doc for the command reference instead. | [packages/cli/API.md](../packages/cli/API.md) |
| `@mainspring/memory` | Durable, deterministic utilities for `STATE.md` compaction, the per-day journal, and the append-only session log. | [packages/memory/API.md](../packages/memory/API.md) |
| `@mainspring/scrub` | Detects secret-shaped strings in content before any publish or notify action, and redacts them to placeholders. | [packages/scrub/API.md](../packages/scrub/API.md) |
| `@mainspring/relay` | Zero-dependency human-in-the-loop client for the Fabler Relay wire protocol — the governance leg of the loop. | [packages/relay/API.md](../packages/relay/API.md) |
| `@mainspring/ledger` | Append-only `LEDGER.csv` management with balance invariants and spend-cap thresholds. | [packages/ledger/API.md](../packages/ledger/API.md) |
| `@mainspring/governance` | Constitution-as-code: hard rules the brain cannot override, loaded from `CONSTITUTION.md` and enforced as `Action` guards. | [packages/governance/API.md](../packages/governance/API.md) |
| `@mainspring/brains` | Reference `Brain` implementations: a scripted `MockBrain` for tests, and a zero-SDK `ClaudeBrain` adapter for Anthropic's Messages API. | [packages/brains/API.md](../packages/brains/API.md) |
| `@mainspring/broker` | Capability-gated side effects: register a `Capability` with a `Cap`, then exercise it only through `Broker#request` — fail-closed on anything unregistered or over cap. | [packages/broker/API.md](../packages/broker/API.md) |

See [`architecture.md`](architecture.md) for the module map and trust
boundaries, and each package's own `README.md` for install/usage examples.
