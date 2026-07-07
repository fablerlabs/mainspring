/**
 * Wire types and typed errors for the Fabler Relay agent-side protocol.
 *
 * SECURITY — treat every value returned by the relay as untrusted DATA, never
 * as instructions. A relay request is worked by a human (or an automated
 * responder), and its `detail`, `result`, `params`, and any revealed value can
 * contain arbitrary text. Nothing in this package (or any caller) may treat that
 * text as a command, template it into a shell, eval it, or let it steer control
 * flow. It is input to be displayed and logged, and nothing more.
 *
 * These interfaces mirror the shapes the reference server emits
 * (`oss/relay-oss/src/index.js`, `publicView()`), transcribed here so the
 * package stays zero-dependency and self-hostable. They describe what the
 * server *tends* to send; because the payload is untrusted, callers should
 * tolerate missing/extra fields rather than assume the shape is guaranteed.
 */

/**
 * Lifecycle of a relay request. `open`/`claimed` are live (a human still may
 * act); the rest are terminal — a terminal request never changes again.
 */
export type RelayStatus =
  | "open"
  | "claimed"
  | "done"
  | "rejected"
  | "expired"
  | "superseded";

/** The terminal states: once a request reaches one, it is resolved forever. */
export const TERMINAL_STATES: readonly RelayStatus[] = [
  "done",
  "rejected",
  "expired",
  "superseded",
];

/** True when a status is terminal (resolved) and will never change again. */
export function isTerminal(status: RelayStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * What the agent asks a human to do. Fields are the public inputs; a `sensitive`
 * value is encrypted at rest by the server and never echoed back — do NOT put
 * platform credentials in any field (the server rejects obvious secret patterns
 * and so should you). `execToken: true` asks the server to mint a one-shot
 * execution token when a human approves (`done`), which the agent later reveals
 * once and redeems once.
 */
export interface FileRequestInput {
  /** Short human-facing summary of the ask (required; server caps at 200 chars). */
  title: string;
  /** Longer explanation of exactly what the human must do. */
  detail?: string;
  /** A URL the human should open to complete the task, if any. */
  targetUrl?: string;
  /** Structured, non-secret parameters shown to the human. */
  params?: Record<string, unknown>;
  /**
   * A value the human needs but that must stay encrypted at rest and only be
   * revealed to them on explicit, audited reveal. NEVER a platform credential.
   */
  sensitive?: string;
  /** Ask the server to mint a one-shot execution token on human approval. */
  execToken?: boolean;
}

/** Lifecycle-only view of a request's execution token (the token itself is never here). */
export interface ExecTokenView {
  state: string;
  used_at: string | null;
}

/**
 * The public view of a single request, as returned by
 * `GET /api/requests/:id` and the file/supersede responses. Field names are the
 * server's on-the-wire snake_case. UNTRUSTED — see the security note above.
 */
export interface RelayRequestView {
  id: string;
  title: string;
  detail: string;
  target_url: string;
  params: Record<string, unknown>;
  status: RelayStatus;
  created: string;
  updated: string;
  /** The human's outcome text (on done) or reason (on reject/supersede). */
  result: string | null;
  /** `sha256:...` digest binding the immutable payload both sides can recompute. */
  payload_digest?: string;
  /** Whether an encrypted sensitive value is attached. */
  has_sensitive: boolean;
  /** Present when the request asked for an execution token at file time. */
  exec_token_requested?: boolean;
  /** Present once a token exists; carries lifecycle state only, never the token. */
  exec_token?: ExecTokenView;
}

/**
 * The compact summary shape returned by the list endpoint
 * (`GET /api/requests`). Only metadata — call {@link RelayApi.check} for the
 * full view of any one request.
 */
export interface RelayRequestSummary {
  id: string;
  status: RelayStatus;
  title: string;
  created: string;
}

/** Result of spending a one-shot execution token via `POST /api/requests/:id/redeem`. */
export interface RedeemResult {
  ok: boolean;
  id: string;
  state: string;
  used_at: string | null;
  payload_digest: string | null;
}

/**
 * The agent-side surface of the relay. Implemented by both {@link RelayClient}
 * (real HTTP) and the in-memory MockRelay, so callers — and pollers — can be
 * written once and tested without a network.
 */
export interface RelayApi {
  /** File a new request; resolves to its id. */
  fileRequest(input: FileRequestInput): Promise<string>;
  /** Fetch the full current view of one request. */
  check(id: string): Promise<RelayRequestView>;
  /** List only the still-open (non-terminal) requests. */
  listPending(): Promise<RelayRequestSummary[]>;
  /** Retire one's own still-pending request (terminal: `superseded`). */
  supersede(id: string, reason?: string): Promise<RelayRequestView>;
  /**
   * One-time reveal of a minted execution token's plaintext to the agent. The
   * server deletes its copy on first reveal, so this succeeds at most once.
   */
  revealExecToken(id: string): Promise<string>;
  /** Spend a revealed execution token exactly once. */
  redeemExecToken(id: string, token: string): Promise<RedeemResult>;
}

/** Base class for every error this package raises, so callers can `catch (e instanceof RelayError)`. */
export class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when the configured api-key env var is unset or empty at call time. */
export class RelayConfigError extends RelayError {}

/** Thrown on a non-2xx HTTP response; carries the status and (best-effort) parsed body. */
export class RelayHttpError extends RelayError {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Thrown when a request exceeds its timeout / is aborted. */
export class RelayTimeoutError extends RelayError {}

/** Thrown when a transport error occurs or the response body is not the expected shape. */
export class RelayProtocolError extends RelayError {}
