import { createHash, randomBytes } from "node:crypto";
import {
  RelayApi,
  RelayHttpError,
  RelayProtocolError,
  FileRequestInput,
  RedeemResult,
  RelayRequestSummary,
  RelayRequestView,
  RelayStatus,
  isTerminal,
} from "./types.js";

/**
 * Internal record: the public view plus the fields the real server keeps hidden
 * (sensitive plaintext, and the execution token's hash/plaintext/reveal state).
 */
interface MockRecord extends RelayRequestView {
  _sensitive?: string;
  _execToken?: { plaintext: string; hash: string; revealed: boolean };
}

/**
 * A dependency-free, in-memory relay that implements the same {@link RelayApi}
 * surface as {@link RelayClient}, plus programmatic controls (`claim`,
 * `resolve`, `reject`, `expire`) that stand in for the human portal. Use it in
 * tests and examples to exercise the full file -> wait -> resolve loop with no
 * network, no server, and no secrets.
 *
 * Fidelity to the reference server: it assigns 8-char ids, computes the same
 * `sha256:` payload digest, keeps `sensitive`/exec-token internals out of the
 * public view, and enforces the same one-shot exec-token and terminal-state
 * rules.
 */
export class MockRelay implements RelayApi {
  private readonly records = new Map<string, MockRecord>();
  private counter = 0;

  async fileRequest(input: FileRequestInput): Promise<string> {
    const title = (input?.title ?? "").trim();
    if (!title) throw new RelayHttpError(400, "title required", { error: "title required" });
    const id = this.nextId();
    const now = new Date().toISOString();
    const rec: MockRecord = {
      id,
      title,
      detail: input.detail ?? "",
      target_url: input.targetUrl ?? "",
      params: input.params ?? {},
      status: "open",
      created: now,
      updated: now,
      result: null,
      has_sensitive: input.sensitive !== undefined,
      payload_digest:
        "sha256:" +
        sha256hex(
          canonical({
            title,
            detail: input.detail ?? "",
            target_url: input.targetUrl ?? "",
            params: input.params ?? {},
          }),
        ),
    };
    if (input.sensitive !== undefined) rec._sensitive = input.sensitive;
    if (input.execToken) rec.exec_token_requested = true;
    this.records.set(id, rec);
    return id;
  }

  async check(id: string): Promise<RelayRequestView> {
    return publicView(this.mustGet(id));
  }

  async listPending(): Promise<RelayRequestSummary[]> {
    return [...this.records.values()]
      .filter((r) => !isTerminal(r.status))
      .sort((a, b) => b.created.localeCompare(a.created))
      .map((r) => ({ id: r.id, status: r.status, title: r.title, created: r.created }));
  }

  async supersede(id: string, reason?: string): Promise<RelayRequestView> {
    const rec = this.mustGet(id);
    if (isTerminal(rec.status)) {
      throw new RelayHttpError(409, "request is already terminal", {
        error: "request is already terminal",
        status: rec.status,
      });
    }
    this.close(rec, "superseded", reason ?? "superseded by agent");
    return publicView(rec);
  }

  async revealExecToken(id: string): Promise<string> {
    const rec = this.mustGet(id);
    if (!rec._execToken) {
      throw new RelayHttpError(404, "no exec token on this request", { error: "no exec token" });
    }
    if (rec._execToken.revealed) {
      throw new RelayHttpError(410, "exec token already revealed", { error: "already revealed" });
    }
    rec._execToken.revealed = true;
    rec.exec_token = { state: "revealed", used_at: rec.exec_token?.used_at ?? null };
    return rec._execToken.plaintext;
  }

  async redeemExecToken(id: string, token: string): Promise<RedeemResult> {
    const rec = this.mustGet(id);
    if (!rec._execToken) {
      throw new RelayHttpError(404, "no exec token on this request", { error: "no exec token" });
    }
    if (rec.exec_token?.state === "used") {
      throw new RelayHttpError(409, "exec token already used", {
        error: "exec token already used — one-shot authorization is spent",
      });
    }
    if (!token || sha256hex(token) !== rec._execToken.hash) {
      throw new RelayHttpError(403, "invalid token", { error: "invalid token" });
    }
    const usedAt = new Date().toISOString();
    rec.exec_token = { state: "used", used_at: usedAt };
    return {
      ok: true,
      id: rec.id,
      state: "used",
      used_at: usedAt,
      payload_digest: rec.payload_digest ?? null,
    };
  }

  // ---- programmatic controls (stand in for the human portal) ----

  /** Move an open request to `claimed`, as the human tapping "Claim" would. */
  claim(id: string): RelayRequestView {
    const rec = this.mustGet(id);
    if (rec.status === "open") {
      rec.status = "claimed";
      rec.updated = new Date().toISOString();
    }
    return publicView(rec);
  }

  /**
   * Resolve a live request as `done` with an outcome, minting the one-shot
   * execution token if it was requested at file time — exactly as a human
   * approval does.
   */
  resolve(id: string, result = "", opts: { mintExecToken?: boolean } = {}): RelayRequestView {
    const rec = this.mustGet(id);
    this.assertLive(rec);
    if ((rec.exec_token_requested || opts.mintExecToken) && !rec._execToken) {
      const token = "fxt_" + randomBytes(24).toString("hex");
      rec._execToken = { plaintext: token, hash: sha256hex(token), revealed: false };
      rec.exec_token = { state: "issued", used_at: null };
    }
    this.close(rec, "done", result);
    return publicView(rec);
  }

  /** Reject a live request with a reason, as the human's "Reject" does. */
  reject(id: string, reason = ""): RelayRequestView {
    const rec = this.mustGet(id);
    this.assertLive(rec);
    this.close(rec, "rejected", reason);
    return publicView(rec);
  }

  /** Force a live request to `expired` (nobody resolved it in time). */
  expire(id: string): RelayRequestView {
    const rec = this.mustGet(id);
    this.assertLive(rec);
    this.close(rec, "expired", rec.result ?? null);
    return publicView(rec);
  }

  private assertLive(rec: MockRecord): void {
    if (isTerminal(rec.status)) {
      throw new RelayHttpError(409, "invalid transition", { error: "invalid transition", status: rec.status });
    }
  }

  private close(rec: MockRecord, status: RelayStatus, result: string | null): void {
    rec.status = status;
    rec.result = result;
    delete rec._sensitive; // sensitive value is purged on close, like the server
    rec.has_sensitive = false;
    rec.updated = new Date().toISOString();
  }

  private mustGet(id: string): MockRecord {
    const rec = this.records.get(id);
    if (!rec) throw new RelayHttpError(404, "not found", { error: "not found" });
    return rec;
  }

  private nextId(): string {
    // Deterministic-ish 8-char id, mirroring the server's UUID-slice width.
    this.counter += 1;
    return `mock${this.counter.toString(16).padStart(4, "0")}`;
  }
}

/** Strip server-hidden internals to produce the public view a caller would see. */
function publicView(rec: MockRecord): RelayRequestView {
  const { _sensitive, _execToken, ...view } = rec;
  return { ...view, params: { ...view.params } };
}

// ---- canonical JSON + sha256, matching oss/relay-oss/src/index.js ----

function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v === undefined ? null : v);
}

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * A decision an {@link EchoResponder} makes about one pending request. This is
 * the mock's answer to core's EchoBrain: a deterministic, zero-config stand-in
 * — here for the *human* side — so the whole governance loop is runnable and
 * testable end to end without a real person in the queue.
 */
export type EchoDecision =
  | { action: "resolve"; result?: string; mintExecToken?: boolean }
  | { action: "reject"; reason?: string }
  | { action: "ignore" };

/** Picks what the echo responder does with a given pending request. */
export type EchoDecider = (view: RelayRequestView) => EchoDecision;

/**
 * Default policy: reject anything whose title asks to be rejected (handy for
 * testing the reject path), resolve everything else with a canned note.
 */
export const defaultEchoDecider: EchoDecider = (view) =>
  /reject/i.test(view.title)
    ? { action: "reject", reason: "echo responder: auto-rejected" }
    : { action: "resolve", result: "echo responder: auto-resolved" };

/**
 * An automated "human" for a {@link MockRelay}: on each {@link runOnce} it looks
 * at every pending request and resolves/rejects it per the decider. Pair it with
 * a brain that files requests to demo or test the full file -> resolve loop with
 * no person present.
 */
export class EchoResponder {
  constructor(
    private readonly relay: MockRelay,
    private readonly decide: EchoDecider = defaultEchoDecider,
  ) {}

  /** Act on every currently-pending request once; returns the requests it touched. */
  async runOnce(): Promise<RelayRequestView[]> {
    const pending = await this.relay.listPending();
    const touched: RelayRequestView[] = [];
    for (const summary of pending) {
      const view = await this.relay.check(summary.id);
      const decision = this.decide(view);
      switch (decision.action) {
        case "resolve":
          touched.push(this.relay.resolve(view.id, decision.result ?? "", { mintExecToken: decision.mintExecToken }));
          break;
        case "reject":
          touched.push(this.relay.reject(view.id, decision.reason ?? ""));
          break;
        case "ignore":
          break;
        default: {
          const exhaustive: never = decision;
          throw new RelayProtocolError(`unknown echo decision: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    return touched;
  }
}
