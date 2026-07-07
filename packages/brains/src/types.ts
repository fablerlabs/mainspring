/**
 * The Brain contract, mirrored from `@mainspring/core`'s `src/types.ts`.
 *
 * This package stays zero-dependency and self-hostable — matching
 * `@mainspring/memory`, `@mainspring/scrub`, and `@mainspring/relay` — so it
 * transcribes the shapes it implements against instead of taking a workspace
 * dependency on core. These types are NOT the source of truth: core owns the
 * contract. If core's `Brain`/`SessionInput`/`StepResult`/`Action` shapes
 * change, update this file to match by hand.
 */

/** ISO-4217 currency amount, always in minor-unit-free decimal USD for v1. */
export interface Money {
  usd: number;
}

/** Token/time accounting for a single brain.step() call. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
}

/** One line of the append-only business ledger. */
export interface LedgerEntry {
  date: string; // ISO 8601
  type: "revenue" | "expense" | "refund" | "adjustment";
  description: string;
  amountUsd: number; // positive number; sign is implied by `type`
}

/** A unit of work the brain wants done — by itself later, or by a human/lane. */
export interface WorkOrder {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

/** A blocker only a human can clear (account creation, CAPTCHA, payment, approval). */
export interface RelayRequest {
  id: string;
  summary: string;
  detail: string;
  estimateMinutes?: number;
  createdAt: string;
}

/** A message from the owner/operator, delivered out-of-band (never from the open web). */
export interface OwnerMessage {
  id: string;
  receivedAt: string;
  text: string;
  approvalCode?: string;
}

/** Result of the self-maintenance / supervisor health check. */
export interface HealthReport {
  ok: boolean;
  lastSessionFailed: boolean;
  notes: string[];
}

/** A tool the brain is allowed to request via a `run` Action. */
export interface ToolSpec {
  name: string;
  description: string;
  argsSchema?: unknown;
}

/** One prior brain <-> loop exchange, for in-session context. */
export interface Turn {
  role: "brain" | "loop";
  content: string;
  at: string;
}

/** Money and behavior caps the gate enforces on every session. */
export interface MoneyCaps {
  perSessionUsd: number;
  notifyAboveUsd: number;
  approvalAboveUsd: number;
}

/** The governing document a workspace is booted with. */
export interface Constitution {
  name: string;
  mission: string;
  hardRules: string[];
  moneyCaps: MoneyCaps;
  maxSessionMs: number;
}

/** Everything a Brain sees to decide what to do next. Assembled fresh each session. */
export interface SessionInput {
  constitution: Constitution;
  state: string; // contents of STATE.md
  journalTail: string; // last N lines of the most recent journal entry
  ledgerTail: LedgerEntry[];
  inbox: OwnerMessage[];
  health: HealthReport;
  pendingRelay: RelayRequest[];
  queue: WorkOrder[];
  tools: ToolSpec[];
  budget: {
    remainingUSD: number;
    sessionMs: number;
  };
}

/** The only vocabulary a Brain can act in. Every kind is validated by the gate. */
export type Action =
  | { kind: "run"; tool: string; args: unknown }
  | { kind: "write"; path: string; content: string }
  | { kind: "ledger"; entry: LedgerEntry }
  | { kind: "enqueue"; order: WorkOrder }
  | { kind: "relay"; request: RelayRequest }
  | { kind: "notify"; to: "owner"; text: string; priority?: "high" }
  | { kind: "done" };

/** What a Brain returns from one reasoning step. */
export interface StepResult {
  actions: Action[];
  usage: Usage;
  done: boolean;
}

/**
 * A Brain is pure reasoning: propose Actions, never execute them, never hold
 * secrets. Implementations wrap a specific model/provider and translate
 * SessionInput + history into a StepResult.
 */
export interface Brain {
  readonly id: string;
  readonly model: string;
  step(input: SessionInput, history: Turn[]): Promise<StepResult>;
  estimateCost?(usage: Usage): Money;
}
