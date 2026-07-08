/**
 * Minimal x402 transport contract, decoupled from any real HTTP/wallet
 * client so the buyer loop (main.ts) can gate a purchase's price *before*
 * money moves — see README.md for why that ordering is the whole point.
 *
 * A real x402 resource server answers an unauthenticated GET with
 * `402 Payment Required` plus a payment challenge (price, recipient,
 * nonce); the client then retries with a payment proof attached and gets
 * the resource back. Libraries like `x402-fetch` collapse that into one
 * auto-paying `fetch()` call, which is exactly wrong for a governed agent:
 * it pays before anything gets a chance to say no. `X402Transport` keeps
 * the two legs — `probe` (free) and `pay` (spends money) — as separate
 * calls so a spendGate can sit between them.
 */

/** The 402 challenge a resource server returns on an unpaid GET. */
export interface X402Challenge {
  url: string;
  priceUsd: number;
  payTo: string;
  nonce: string;
}

/** What `pay()` returns once the challenge has actually been settled. */
export interface X402Receipt {
  url: string;
  amountUsd: number;
  receiptId: string;
  body: string;
}

/**
 * Transport seam: swap `MockX402Transport` below for a real implementation
 * (e.g. one backed by `x402-fetch`'s lower-level primitives, or a direct
 * HTTP client) without touching the buyer loop or the spendGate rules —
 * both only ever see this interface.
 */
export interface X402Transport {
  /** GETs `url` unauthenticated. Free: a real x402 server always answers 402 on the first, unpaid hit. */
  probe(url: string): Promise<X402Challenge>;
  /** Retries `challenge` with proof of payment. Must only ever be called after a spendGate allows the price. */
  pay(challenge: X402Challenge): Promise<X402Receipt>;
}

export interface X402CatalogEntry {
  priceUsd: number;
  payTo: string;
  body: string;
}

/**
 * Canned, offline stand-in for a real x402 resource server: `probe` returns
 * a fixed challenge per URL, `pay` returns a fixed receipt. No network. Also
 * records which URLs it actually charged, so tests can assert a blocked
 * purchase never reached `pay`.
 */
export class MockX402Transport implements X402Transport {
  #catalog: Map<string, X402CatalogEntry>;
  #paidUrls: string[] = [];

  constructor(catalog: Record<string, X402CatalogEntry>) {
    this.#catalog = new Map(Object.entries(catalog));
  }

  /** URLs actually paid for, in call order. A blocked purchase must never appear here. */
  get paidUrls(): readonly string[] {
    return this.#paidUrls.slice();
  }

  async probe(url: string): Promise<X402Challenge> {
    const entry = this.#catalog.get(url);
    if (!entry) throw new Error(`MockX402Transport: no canned listing for ${url}`);
    return { url, priceUsd: entry.priceUsd, payTo: entry.payTo, nonce: `nonce-${this.#paidUrls.length}-${url}` };
  }

  async pay(challenge: X402Challenge): Promise<X402Receipt> {
    const entry = this.#catalog.get(challenge.url);
    if (!entry) throw new Error(`MockX402Transport: no canned listing for ${challenge.url}`);
    this.#paidUrls.push(challenge.url);
    return {
      url: challenge.url,
      amountUsd: challenge.priceUsd,
      receiptId: `receipt-${this.#paidUrls.length}`,
      body: entry.body,
    };
  }
}
