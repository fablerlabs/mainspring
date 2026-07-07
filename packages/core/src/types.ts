/**
 * Mainspring core contracts.
 *
 * A Brain is pure reasoning: given the current state of the business, it
 * proposes a list of Actions. It never touches the filesystem, the network,
 * or a secret directly. The session loop (assemble -> brain.step -> gate ->
 * dispatch) is the only code that ever executes a side effect, and it does
 * so only after every Action has been checked against the Constitution.
 * This split is what makes the brain swappable: any model/provider can
 * implement `step()` and be dropped in without touching the trust boundary.
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
  /** Hard ceiling on total spend actioned in a single session, before any approval. */
  perSessionUsd: number;
  /** Spend at/above this requires notifying the owner before acting. */
  notifyAboveUsd: number;
  /** Spend at/above this requires an owner-supplied approval code before acting. */
  approvalAboveUsd: number;
}

/** The governing document a workspace is booted with. Adapt, don't fork the loop. */
export interface Constitution {
  name: string;
  mission: string;
  /** Plain-English rules; the gate matches Actions against these structurally where it can. */
  hardRules: string[];
  moneyCaps: MoneyCaps;
  /** Max wall-clock a single session may run before the loop force-stops it. */
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
 * A Brain is pure reasoning: propose Actions, never execute them, never
 * hold secrets. Implementations wrap a specific model/provider and translate
 * SessionInput + history into a StepResult.
 */
export interface Brain {
  readonly id: string;
  readonly model: string;
  step(input: SessionInput, history: Turn[]): Promise<StepResult>;
  estimateCost?(usage: Usage): Money;
}

/** Outcome of running one Action through the gate. */
export interface GateDecision {
  action: Action;
  allowed: boolean;
  reason?: string;
}

/** Outcome of dispatching one allowed Action. */
export interface DispatchResult {
  action: Action;
  applied: boolean;
  detail?: string;
}

/** Summary written by the loop at the end of a session, read by `mainspring status`. */
export interface SessionSummary {
  startedAt: string;
  endedAt: string;
  steps: number;
  actionsProposed: number;
  actionsAllowed: number;
  actionsBlocked: number;
  blockedReasons: string[];
  spentUsd: number;
  done: boolean;
}
