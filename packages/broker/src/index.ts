/**
 * @mainspring/broker — capability-gated side effects: spend/message/publish
 * requests are checked against per-capability caps and audited, allow or
 * deny, before anything happens. Generalizes docs/broker/SPEC.md. Zero
 * network, zero real credentials.
 */

export { Broker } from "./broker.js";
export { createMemoryBroker, DEFAULT_SPEND_CAP, type MemoryBroker, type MemoryBrokerOptions } from "./memoryBroker.js";
export type { Cap, Capability, BrokerRequest, BrokerResult, AuditEntry, CapabilityHandler } from "./types.js";
