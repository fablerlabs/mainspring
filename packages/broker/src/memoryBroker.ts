/**
 * In-memory reference broker: wires one sample capability, "spend", to an
 * in-memory @mainspring/ledger `Ledger` — no real payment rail. This is the
 * pattern a real capability (a Stripe charge, a Telegram send) follows: the
 * handler is the only code that ever touches the actual side effect, and it
 * only runs after `Broker#request` has already checked the cap.
 */
import { Ledger, type LedgerEntryType } from "@mainspring/ledger";
import { Broker } from "./broker.js";
import type { BrokerRequest, Cap } from "./types.js";

/** Mirrors the constitution's default expense guardrail: notify-band amount, ten mutations/day. */
export const DEFAULT_SPEND_CAP: Cap = { maxAmountUsd: 75, maxCallsPerDay: 10 };

export interface MemoryBrokerOptions {
  spendCap?: Cap;
  clock?: () => Date;
}

export interface MemoryBroker {
  broker: Broker;
  /** The in-memory ledger the sample "spend" capability appends to — inspect it in tests/demos; nothing else touches it. */
  ledger: Ledger;
}

/**
 * Builds a Broker with one registered capability, "spend": every authorized
 * request appends an `expense` entry to an in-memory ledger and returns the
 * new balance. Swap the handler for a real payment call and the cap
 * enforcement + audit trail above it are unchanged.
 */
export function createMemoryBroker(options: MemoryBrokerOptions = {}): MemoryBroker {
  const clock = options.clock ?? (() => new Date());
  const ledger = new Ledger();
  const broker = new Broker({ clock });

  broker.register(
    {
      id: "spend",
      description: "Appends a capped expense entry to an in-memory ledger — reference for a real payment capability behind the same broker.",
      cap: options.spendCap ?? DEFAULT_SPEND_CAP,
    },
    (req: BrokerRequest) => {
      if (req.amountUsd === undefined) {
        throw new Error('"spend" requires amountUsd');
      }
      const type: LedgerEntryType = "expense";
      const row = ledger.append({
        date: clock().toISOString(),
        type,
        description: req.op,
        amountUsd: req.amountUsd,
      });
      return { balanceUsd: row.balanceUsd };
    },
  );

  return { broker, ledger };
}
