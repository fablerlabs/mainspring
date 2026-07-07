/**
 * The broker: registers capabilities, enforces their caps, and appends one
 * audit entry per attempt — allow or deny — before anything else happens.
 * Fails closed throughout: an unregistered capability, a missing allowlist
 * target, an over-amount or over-cap request are all denied without ever
 * reaching the handler. Zero network, zero real credentials — a real
 * capability (Stripe, Telegram, ...) is wired in by whoever registers its
 * handler; this module only ever sees amounts, targets, and op labels.
 */
import type { AuditEntry, BrokerRequest, BrokerResult, Capability, CapabilityHandler, Cap } from "./types.js";

interface RegisteredCapability {
  capability: Capability;
  handler: CapabilityHandler;
}

function dayKeyOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class Broker {
  #capabilities = new Map<string, RegisteredCapability>();
  #audit: AuditEntry[] = [];
  #dailyCounts = new Map<string, Map<string, number>>();
  #clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  /** Registers one capability's cap and handler. Throws if `capability.id` is already registered — capabilities are fixed at wiring time, not re-defined mid-run. */
  register(capability: Capability, handler: CapabilityHandler): void {
    if (this.#capabilities.has(capability.id)) {
      throw new Error(`capability already registered: ${capability.id}`);
    }
    this.#capabilities.set(capability.id, { capability, handler });
  }

  /** The full audit trail so far, oldest first. A frozen copy — mutating it cannot affect the broker's own record. */
  get audit(): readonly AuditEntry[] {
    return Object.freeze(this.#audit.slice());
  }

  /** Checks `req` against its capability's cap and, if authorized, calls the handler. Always appends exactly one audit entry, whatever the outcome. */
  async request(req: BrokerRequest): Promise<BrokerResult> {
    const now = this.#clock();
    const dayKey = dayKeyOf(now);

    const registered = this.#capabilities.get(req.capability);
    if (!registered) {
      return this.#deny(req, now, dayKey, `unknown capability: ${req.capability}`);
    }
    const { capability, handler } = registered;
    const { cap } = capability;

    const allowlistReason = this.#checkAllowlist(req, cap);
    if (allowlistReason) return this.#deny(req, now, dayKey, allowlistReason);

    const amountReason = this.#checkAmount(req, cap);
    if (amountReason) return this.#deny(req, now, dayKey, amountReason);

    const countToday = this.#countFor(capability.id, dayKey);
    if (countToday >= cap.maxCallsPerDay) {
      return this.#deny(req, now, dayKey, `daily call cap (${cap.maxCallsPerDay}) reached for capability "${capability.id}"`);
    }

    const callIndexToday = countToday + 1;
    this.#setCountFor(capability.id, dayKey, callIndexToday);

    try {
      const output = await handler(req);
      this.#record(req, now, dayKey, true, "ok", callIndexToday);
      return { allowed: true, reason: "ok", output };
    } catch (err) {
      const reason = `handler threw: ${err instanceof Error ? err.message : String(err)}`;
      this.#record(req, now, dayKey, false, reason, callIndexToday);
      return { allowed: false, reason };
    }
  }

  #checkAllowlist(req: BrokerRequest, cap: Cap): string | null {
    if (!cap.allowlist) return null;
    if (req.target === undefined || !cap.allowlist.includes(req.target)) {
      return `target ${req.target === undefined ? "(none given)" : `"${req.target}"`} not on allowlist for capability "${req.capability}"`;
    }
    return null;
  }

  #checkAmount(req: BrokerRequest, cap: Cap): string | null {
    if (cap.maxAmountUsd === undefined || req.amountUsd === undefined) return null;
    if (req.amountUsd > cap.maxAmountUsd) {
      return `amountUsd ${req.amountUsd} exceeds cap ${cap.maxAmountUsd} for capability "${req.capability}"`;
    }
    return null;
  }

  #countFor(capabilityId: string, dayKey: string): number {
    return this.#dailyCounts.get(capabilityId)?.get(dayKey) ?? 0;
  }

  #setCountFor(capabilityId: string, dayKey: string, count: number): void {
    const perDay = this.#dailyCounts.get(capabilityId) ?? new Map<string, number>();
    perDay.set(dayKey, count);
    this.#dailyCounts.set(capabilityId, perDay);
  }

  #deny(req: BrokerRequest, now: Date, dayKey: string, reason: string): BrokerResult {
    this.#record(req, now, dayKey, false, reason);
    return { allowed: false, reason };
  }

  #record(req: BrokerRequest, now: Date, dayKey: string, allowed: boolean, reason: string, callIndexToday?: number): void {
    this.#audit.push(
      Object.freeze({
        timestamp: now.toISOString(),
        capability: req.capability,
        op: req.op,
        target: req.target,
        amountUsd: req.amountUsd,
        allowed,
        reason,
        dayKey,
        callIndexToday,
      }),
    );
  }
}
