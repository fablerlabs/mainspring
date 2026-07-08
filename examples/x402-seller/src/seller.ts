/**
 * A governed x402 SELLER: an agent that operates paid HTTP endpoints and
 * settles agent payments — with the constitution wired in front of every
 * money-affecting operation.
 *
 *   @mainspring/governance — `evaluate()` + the `Rule`/`Verdict` engine, which
 *                            BLOCKS an over-cap price change and any refund the
 *                            operator's policy does not name.
 *   @mainspring/ledger     — the append-only `Ledger`, into which every settled
 *                            sale writes revenue and every authorized refund
 *                            writes a refund, balance invariants and all.
 *
 * The settle flow is a faithful but OFFLINE simulation of x402: a request to a
 * paid route returns an HTTP 402 quote; the buyer "pays" and re-presents a
 * payment proof; the seller verifies the proof against the quote it issued and
 * only then records revenue. No network, no chain, no secrets — this proves the
 * governance and the bookkeeping, not a settlement backend. See the README.
 */
import { evaluate, type Action, type Rule } from "@mainspring/governance";
import { Ledger, type LedgerRow } from "@mainspring/ledger";
import { sellerRules } from "./rules.js";

/** A paid endpoint the seller offers, priced per call. */
export interface EndpointConfig {
  route: string;
  priceUsd: number;
  description?: string;
}

/** The operator's declared policy — the two things governance enforces. */
export interface SellerPolicy {
  /** No endpoint may be priced above this cap (USD). Enforced by the `price-cap` rule. */
  maxPriceUsd: number;
  /** The only reasons a refund may be issued for. Enforced by the `refund-policy` rule. */
  refundReasons: string[];
}

export interface SellerOptions {
  endpoints: EndpointConfig[];
  policy: SellerPolicy;
  /** Injectable clock so runs are reproducible in tests. Defaults to wall-clock ISO time. */
  now?: () => string;
}

/** The HTTP 402 "Payment Required" quote a paid route returns before it will serve. */
export interface PaymentQuote {
  status: 402;
  route: string;
  amountUsd: number;
  asset: "USDC";
  network: "base";
  /** Single-use id the buyer echoes back when it settles. */
  quoteId: string;
}

/** What a buyer presents to settle a quote. Simulated: `txRef` stands in for a settled on-chain tx. */
export interface PaymentProof {
  quoteId: string;
  amountUsd: number;
  txRef: string;
}

/** The 200 receipt a settled sale returns, alongside the ledger row it wrote. */
export interface SaleReceipt {
  status: 200;
  saleId: string;
  route: string;
  amountUsd: number;
  txRef: string;
  settledAt: string;
}

/** The outcome of a governed operation (price change / refund): allow or a cited block. */
export interface GovernedResult<T> {
  allowed: boolean;
  reason: string;
  /** Ids of any governance rules that fired (non-allow). Empty when allowed. */
  firedRules: string[];
  /** Present only when `allowed`. */
  value?: T;
}

/** One line of the seller's audit trail — every settle, price change, and refund attempt. */
export interface SellerAuditEntry {
  op: "settle" | "set-price" | "refund";
  target: string;
  amountUsd: number;
  allowed: boolean;
  reason: string;
}

/** Thrown for malformed protocol use (unknown route, replayed/underpaid quote) — not a governance block. */
export class SellerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellerError";
  }
}

export class Seller {
  readonly #prices = new Map<string, number>();
  readonly #descriptions = new Map<string, string>();
  readonly #policy: SellerPolicy;
  readonly #rules: Rule[];
  readonly #ledger = new Ledger();
  readonly #now: () => string;
  readonly #openQuotes = new Map<string, { route: string; amountUsd: number }>();
  readonly #sales = new Map<string, SaleReceipt>();
  readonly #refunded = new Set<string>();
  readonly #audit: SellerAuditEntry[] = [];
  #seq = 0;

  constructor(options: SellerOptions) {
    this.#policy = options.policy;
    this.#rules = sellerRules(options.policy);
    this.#now = options.now ?? (() => new Date().toISOString());

    for (const ep of options.endpoints) {
      // A misconfigured endpoint priced above the cap is a config error, caught
      // at construction rather than on the first sale.
      if (ep.priceUsd > options.policy.maxPriceUsd) {
        throw new SellerError(
          `endpoint ${ep.route} priced at $${ep.priceUsd} exceeds the $${options.policy.maxPriceUsd} cap`,
        );
      }
      this.#prices.set(ep.route, ep.priceUsd);
      if (ep.description) this.#descriptions.set(ep.route, ep.description);
    }
  }

  /** Next monotonic id suffix — deterministic, so runs with a fixed clock reproduce exactly. */
  #nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${String(this.#seq).padStart(4, "0")}`;
  }

  /** The current price for a route, or `undefined` if the route is not offered. */
  priceOf(route: string): number | undefined {
    return this.#prices.get(route);
  }

  /**
   * Step 1 of the x402 flow: a request to a paid route. Returns the HTTP 402
   * quote the buyer must satisfy. The quote is recorded so `settle` can verify
   * the payment against exactly what was quoted (and enforce single use).
   */
  quote(route: string): PaymentQuote {
    const amountUsd = this.#prices.get(route);
    if (amountUsd === undefined) {
      throw new SellerError(`no such endpoint: ${route}`);
    }
    const quoteId = this.#nextId("quote");
    this.#openQuotes.set(quoteId, { route, amountUsd });
    return { status: 402, route, amountUsd, asset: "USDC", network: "base", quoteId };
  }

  /**
   * Step 2 of the x402 flow (simulated settle, NO network): the buyer presents
   * a payment proof. The seller verifies the quote is live and the paid amount
   * matches what it quoted, consumes the quote (single-use — no replay), writes
   * a revenue row to @mainspring/ledger, and returns the 200 receipt.
   */
  settle(proof: PaymentProof): SaleReceipt {
    const quote = this.#openQuotes.get(proof.quoteId);
    if (!quote) {
      throw new SellerError(`unknown or already-settled quote: ${proof.quoteId}`);
    }
    // Verify BEFORE consuming: an underpaid/malformed attempt is rejected but
    // leaves the quote open for a correct retry. Only a settled sale burns it,
    // so a real payment can't be replayed.
    if (!Number.isFinite(proof.amountUsd) || proof.amountUsd !== quote.amountUsd) {
      throw new SellerError(
        `payment $${proof.amountUsd} does not match quoted $${quote.amountUsd} for ${quote.route}`,
      );
    }
    this.#openQuotes.delete(proof.quoteId);

    const saleId = this.#nextId("sale");
    const settledAt = this.#now();
    // Every sale writes to @mainspring/ledger — revenue, with the balance invariant enforced.
    this.#ledger.append({
      date: settledAt,
      type: "revenue",
      description: `x402 ${quote.route} (${saleId})`,
      amountUsd: quote.amountUsd,
    });
    const receipt: SaleReceipt = {
      status: 200,
      saleId,
      route: quote.route,
      amountUsd: quote.amountUsd,
      txRef: proof.txRef,
      settledAt,
    };
    this.#sales.set(saleId, receipt);
    this.#audit.push({ op: "settle", target: quote.route, amountUsd: quote.amountUsd, allowed: true, reason: `settled ${saleId}` });
    return receipt;
  }

  /**
   * Change an endpoint's price — GOVERNED. The change is expressed as a `run`
   * Action and put through `@mainspring/governance`; a price above the cap is
   * blocked with the rule's own reason and the price is left untouched.
   */
  setPrice(route: string, newPriceUsd: number): GovernedResult<number> {
    if (!this.#prices.has(route)) {
      throw new SellerError(`no such endpoint: ${route}`);
    }
    const action: Action = { kind: "run", tool: "set-price", args: { route, newPriceUsd } };
    const { verdict, firedRules } = evaluate(action, this.#rules);
    // The audited amount is the *attempted* price; keep it finite for the trail.
    const auditedAmount = Number.isFinite(newPriceUsd) ? newPriceUsd : Number.NaN;

    if (verdict !== "allow") {
      const reason = firedRules[0]?.description ?? `price change blocked (${verdict})`;
      this.#audit.push({ op: "set-price", target: route, amountUsd: auditedAmount, allowed: false, reason });
      return { allowed: false, reason, firedRules: firedRules.map((r) => r.id) };
    }

    this.#prices.set(route, newPriceUsd);
    const reason = `price for ${route} set to $${newPriceUsd.toFixed(2)}`;
    this.#audit.push({ op: "set-price", target: route, amountUsd: newPriceUsd, allowed: true, reason });
    return { allowed: true, reason, firedRules: [], value: newPriceUsd };
  }

  /**
   * Refund a settled sale — GOVERNED. Expressed as a `run` Action and put
   * through governance: a refund whose reason is not in the policy is blocked,
   * and only an authorized refund writes a `refund` row to @mainspring/ledger.
   */
  refund(saleId: string, reason: string): GovernedResult<LedgerRow> {
    const sale = this.#sales.get(saleId);
    if (!sale) {
      return { allowed: false, reason: `no such sale: ${saleId}`, firedRules: [] };
    }
    if (this.#refunded.has(saleId)) {
      return { allowed: false, reason: `sale ${saleId} was already refunded`, firedRules: [] };
    }

    const action: Action = { kind: "run", tool: "refund", args: { saleId, reason, amountUsd: sale.amountUsd } };
    const { verdict, firedRules } = evaluate(action, this.#rules);
    if (verdict !== "allow") {
      const why = firedRules[0]?.description ?? `refund blocked (${verdict})`;
      this.#audit.push({ op: "refund", target: saleId, amountUsd: sale.amountUsd, allowed: false, reason: why });
      return { allowed: false, reason: why, firedRules: firedRules.map((r) => r.id) };
    }

    const row = this.#ledger.append({
      date: this.#now(),
      type: "refund",
      description: `refund ${saleId}: ${reason}`,
      amountUsd: sale.amountUsd,
    });
    this.#refunded.add(saleId);
    const okReason = `refunded ${saleId} ($${sale.amountUsd.toFixed(2)}): ${reason}`;
    this.#audit.push({ op: "refund", target: saleId, amountUsd: sale.amountUsd, allowed: true, reason: okReason });
    return { allowed: true, reason: okReason, firedRules: [], value: row };
  }

  /** Net revenue (revenue minus refunds) — the ledger's running balance. */
  netRevenueUsd(): number {
    return this.#ledger.balance();
  }

  /** LEDGER.csv text for the whole run, header + every row. */
  ledgerCsv(): string {
    return this.#ledger.toCsv();
  }

  /** A frozen copy of the audit trail (every settle, price change, and refund attempt). */
  get audit(): readonly SellerAuditEntry[] {
    return Object.freeze(this.#audit.slice());
  }

  /** A frozen copy of the ledger rows. */
  get ledgerRows(): readonly LedgerRow[] {
    return this.#ledger.entries;
  }
}
