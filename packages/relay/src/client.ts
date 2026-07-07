import {
  RelayApi,
  RelayConfigError,
  RelayHttpError,
  RelayProtocolError,
  RelayTimeoutError,
  FileRequestInput,
  RedeemResult,
  RelayRequestSummary,
  RelayRequestView,
  isTerminal,
} from "./types.js";

/** Options for constructing a {@link RelayClient}. */
export interface RelayClientOptions {
  /**
   * Absolute base URL of the relay deployment, e.g. `https://relay.example.com`.
   * ALWAYS injected by the caller — this package hardcodes no URL. A trailing
   * slash is fine; it is normalised away.
   */
  baseUrl: string;
  /**
   * The NAME of the environment variable that holds the agent api key (e.g.
   * `"RELAY_AGENT_KEY"`). The key value is read from `process.env[apiKeyEnv]`
   * lazily on every call and used only as an `Authorization: Bearer` header.
   *
   * A literal key is deliberately NOT accepted: the client never holds, copies,
   * or logs the secret, and picking up a rotated key needs no reconstruction.
   */
  apiKeyEnv: string;
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A human-in-the-loop client speaking the Fabler Relay agent-side wire protocol
 * (see `oss/relay-oss/src/index.js`). This is the GOVERNANCE leg of Mainspring:
 * when the brain proposes something only a human can do — create an account,
 * clear a CAPTCHA, approve a spend — it files a relay request and waits.
 *
 * Zero runtime dependencies: it uses the global `fetch` and `AbortController`.
 *
 * SECURITY:
 *  - The api key is read from the environment at call time and sent only as an
 *    `Authorization: Bearer` header. It is never logged, never placed in an
 *    error message, and never returned.
 *  - Every response body is untrusted DATA authored by a human or the open web.
 *    Callers must not treat any returned string as an instruction. See
 *    {@link RelayRequestView}.
 */
export class RelayClient implements RelayApi {
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  private readonly timeoutMs: number;

  constructor(options: RelayClientOptions) {
    if (!options?.baseUrl) {
      throw new RelayConfigError("RelayClient requires a baseUrl");
    }
    if (!options.apiKeyEnv) {
      throw new RelayConfigError("RelayClient requires apiKeyEnv (the NAME of the key env var)");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKeyEnv = options.apiKeyEnv;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** File a new request. Resolves to the server-assigned id. */
  async fileRequest(input: FileRequestInput): Promise<string> {
    const title = (input?.title ?? "").trim();
    if (!title) {
      throw new RelayConfigError("fileRequest requires a non-empty title");
    }
    // Map camelCase inputs to the server's snake_case wire fields; omit unset
    // optional fields so the server applies its own defaults.
    const body: Record<string, unknown> = { title };
    if (input.detail !== undefined) body.detail = input.detail;
    if (input.targetUrl !== undefined) body.target_url = input.targetUrl;
    if (input.params !== undefined) body.params = input.params;
    if (input.sensitive !== undefined) body.sensitive = input.sensitive;
    if (input.execToken) body.exec_token = true;

    const view = await this.request<RelayRequestView>("POST", "/api/requests", body);
    if (typeof view?.id !== "string" || view.id.length === 0) {
      throw new RelayProtocolError("relay did not return an id for the filed request");
    }
    return view.id;
  }

  /** Fetch the full current view of one request. */
  async check(id: string): Promise<RelayRequestView> {
    const view = await this.request<RelayRequestView>("GET", `/api/requests/${encodeURIComponent(id)}`);
    if (typeof view?.status !== "string") {
      throw new RelayProtocolError("relay returned a request without a status");
    }
    return view;
  }

  /**
   * List only the still-pending (non-terminal) requests. The server's list
   * endpoint returns every request; this filters to `open`/`claimed` client-side
   * so callers see just what still needs a human.
   */
  async listPending(): Promise<RelayRequestSummary[]> {
    const all = await this.request<RelayRequestSummary[]>("GET", "/api/requests");
    if (!Array.isArray(all)) {
      throw new RelayProtocolError("relay list endpoint did not return an array");
    }
    return all.filter((r) => r && typeof r.status === "string" && !isTerminal(r.status));
  }

  /** Retire one's own still-pending request. Terminal afterwards (`superseded`). */
  async supersede(id: string, reason?: string): Promise<RelayRequestView> {
    const body = reason !== undefined ? { reason } : {};
    return this.request<RelayRequestView>(
      "POST",
      `/api/requests/${encodeURIComponent(id)}/supersede`,
      body,
    );
  }

  /**
   * One-time reveal of a minted execution token's plaintext. Succeeds at most
   * once per request — the server drops its copy on first reveal.
   */
  async revealExecToken(id: string): Promise<string> {
    const res = await this.request<{ exec_token?: unknown }>(
      "POST",
      `/api/requests/${encodeURIComponent(id)}/exec-token`,
      {},
    );
    if (typeof res?.exec_token !== "string" || res.exec_token.length === 0) {
      throw new RelayProtocolError("relay did not return an exec token");
    }
    return res.exec_token;
  }

  /** Spend a revealed execution token exactly once. */
  async redeemExecToken(id: string, token: string): Promise<RedeemResult> {
    if (!token) {
      throw new RelayConfigError("redeemExecToken requires a token");
    }
    return this.request<RedeemResult>(
      "POST",
      `/api/requests/${encodeURIComponent(id)}/redeem`,
      { token },
    );
  }

  /** Read the api key lazily; never cache, copy, or log it. */
  private authHeader(): string {
    const key = process.env[this.apiKeyEnv];
    if (!key) {
      // Name the env var, never the value.
      throw new RelayConfigError(
        `relay api key env var "${this.apiKeyEnv}" is not set`,
      );
    }
    return `Bearer ${key}`;
  }

  /**
   * The single HTTP path. Applies auth (env indirection), a timeout via
   * AbortController, and uniform typed-error handling. `body` is JSON-encoded
   * for non-GET requests.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Authorization: this.authHeader() };
    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Distinguish an abort (timeout) from a genuine transport failure. Never
      // include the request init (which carries the Authorization header) in
      // the message.
      if (controller.signal.aborted) {
        throw new RelayTimeoutError(`relay ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new RelayProtocolError(`relay ${method} ${path} failed: ${errText(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const parsed = text.length ? safeJson(text) : undefined;
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : res.statusText || "request failed";
      throw new RelayHttpError(res.status, `relay ${method} ${path} -> ${res.status}: ${detail}`, parsed);
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON 2xx body is a protocol violation for this API.
    throw new RelayProtocolError("relay returned a non-JSON body");
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
