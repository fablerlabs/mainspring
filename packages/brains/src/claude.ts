import type { Action, Brain, Money, SessionInput, StepResult, ToolSpec, Turn, Usage } from "./types.js";

/**
 * Reference Brain adapter for Anthropic's Messages API. Zero SDK
 * dependencies — it builds the request with `buildClaudeRequest` (a pure
 * function, safe to unit test without a network call) and sends it with
 * `fetch`. The API key is read from the constructor arg only; this class
 * never touches `process.env` — Mainspring's rule is that secrets are
 * injected by the caller, not discovered by the brain.
 *
 * The model id below is a placeholder: real Anthropic model ids change over
 * time, so production config should always set `model` explicitly.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-x";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_MAX_TOKENS = 4096;

/** The one tool name every ClaudeBrain request registers, alongside the caller's own ToolSpecs. */
export const PROPOSE_ACTIONS_TOOL = "propose_actions";

export interface ClaudeBrainConfig {
  /** Anthropic API key. Required, and only ever read from here — never from the environment. */
  apiKey: string;
  /** Anthropic model id. Defaults to a placeholder; set explicitly in production. */
  model?: string;
  /** System prompt describing the brain's role. Optional; omitted from the request when unset. */
  systemPrompt?: string;
  maxTokens?: number;
  /** Override the Messages endpoint (tests / API proxies only). */
  apiUrl?: string;
  /** Override the `anthropic-version` header. */
  anthropicVersion?: string;
}

export interface AnthropicToolSpec {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicMessagesRequestBody {
  model: string;
  system?: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  tools: AnthropicToolSpec[];
}

export interface AnthropicRequest {
  url: string;
  headers: Record<string, string>;
  body: AnthropicMessagesRequestBody;
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}

/** The meta tool the brain must call to actually propose Actions to the gate. */
function actionsToolSpec(): AnthropicToolSpec {
  return {
    name: PROPOSE_ACTIONS_TOOL,
    description:
      "Propose the Actions the session loop should gate and dispatch this step, and whether the " +
      "session is done. This is the only way to affect the workspace: call it exactly once per " +
      "step with every action you want taken, using the kind vocabulary run | write | ledger | " +
      "enqueue | relay | notify | done.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Zero or more Actions, each a discriminated object with a `kind` field.",
          items: { type: "object" },
        },
        done: {
          type: "boolean",
          description: "True if the session should end once these actions are applied.",
        },
      },
      required: ["actions", "done"],
    },
  };
}

function toolSpecToAnthropicTool(spec: ToolSpec): AnthropicToolSpec {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.argsSchema ?? { type: "object" },
  };
}

/** Render the assembled SessionInput as the brain's next user-turn prompt. */
function renderSessionInput(input: SessionInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.constitution.name}`);
  lines.push(input.constitution.mission);
  lines.push("");
  lines.push("## Hard rules");
  for (const rule of input.constitution.hardRules) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("## STATE.md");
  lines.push(input.state);
  lines.push("");
  lines.push("## Journal tail");
  lines.push(input.journalTail);
  lines.push("");
  lines.push(`## Ledger tail (${input.ledgerTail.length} entries)`);
  lines.push(JSON.stringify(input.ledgerTail));
  lines.push("");
  lines.push(`## Inbox (${input.inbox.length} messages)`);
  lines.push(JSON.stringify(input.inbox));
  lines.push("");
  lines.push("## Health");
  lines.push(JSON.stringify(input.health));
  lines.push("");
  lines.push(`## Pending relay (${input.pendingRelay.length})`);
  lines.push(JSON.stringify(input.pendingRelay));
  lines.push("");
  lines.push(`## Queue (${input.queue.length})`);
  lines.push(JSON.stringify(input.queue));
  lines.push("");
  lines.push("## Budget");
  lines.push(JSON.stringify(input.budget));
  lines.push("");
  lines.push(
    `Call ${PROPOSE_ACTIONS_TOOL} with the Actions you want this step, and whether the session is done.`,
  );
  return lines.join("\n");
}

/**
 * Pure request builder: SessionInput + history + config in, an Anthropic
 * Messages API request out. No network access — safe to unit test directly.
 */
export function buildClaudeRequest(
  input: SessionInput,
  history: Turn[],
  config: ClaudeBrainConfig,
): AnthropicRequest {
  const messages: AnthropicMessage[] = history.map((turn) => ({
    role: turn.role === "brain" ? "assistant" : "user",
    content: turn.content,
  }));
  messages.push({ role: "user", content: renderSessionInput(input) });

  const tools: AnthropicToolSpec[] = [actionsToolSpec(), ...input.tools.map(toolSpecToAnthropicTool)];

  return {
    url: config.apiUrl ?? ANTHROPIC_MESSAGES_URL,
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": config.anthropicVersion ?? ANTHROPIC_VERSION,
    },
    body: {
      model: config.model ?? DEFAULT_CLAUDE_MODEL,
      ...(config.systemPrompt ? { system: config.systemPrompt } : {}),
      max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      tools,
    },
  };
}

/**
 * Pure response parser: an Anthropic Messages API response in, a StepResult
 * out. The `propose_actions` tool_use block supplies the Action list and the
 * done flag; any other tool_use block is treated as a `run` Action against
 * the caller's own ToolSpec registry. No network access — safe to unit test
 * directly with a fixture response.
 */
export function parseClaudeResponse(response: AnthropicMessagesResponse, wallMs: number): StepResult {
  const actions: Action[] = [];
  let done = false;

  for (const block of response.content ?? []) {
    if (block.type !== "tool_use" || !block.name) continue;

    if (block.name === PROPOSE_ACTIONS_TOOL) {
      const proposed = block.input as { actions?: Action[]; done?: boolean } | undefined;
      if (proposed?.actions) actions.push(...proposed.actions);
      if (proposed?.done) done = true;
    } else {
      actions.push({ kind: "run", tool: block.name, args: block.input });
    }
  }

  const usage: Usage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    wallMs,
  };

  return { actions, usage, done };
}

export class ClaudeBrain implements Brain {
  readonly id = "claude";
  readonly model: string;

  private readonly config: ClaudeBrainConfig;

  constructor(config: ClaudeBrainConfig) {
    if (!config.apiKey) {
      throw new Error("ClaudeBrain: apiKey is required and must be passed explicitly (never read from process.env)");
    }
    this.config = config;
    this.model = config.model ?? DEFAULT_CLAUDE_MODEL;
  }

  async step(input: SessionInput, history: Turn[]): Promise<StepResult> {
    const { url, headers, body } = buildClaudeRequest(input, history, this.config);

    const startedAt = Date.now();
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const wallMs = Date.now() - startedAt;

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ClaudeBrain: Anthropic API returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    return parseClaudeResponse(data, wallMs);
  }

  /** Pricing varies by model/tier and changes over time; v1 reports $0 rather than guess. */
  estimateCost(_usage: Usage): Money {
    return { usd: 0 };
  }
}
