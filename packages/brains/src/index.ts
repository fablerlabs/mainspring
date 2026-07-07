/**
 * @mainspring/brains — reference implementations of the `Brain` contract
 * (mirrored from `@mainspring/core`): a scripted MockBrain for tests and
 * examples, and a ClaudeBrain adapter for Anthropic's Messages API. Zero
 * runtime dependencies; ClaudeBrain uses `fetch` directly, no SDK.
 */

export { MockBrain } from "./mock.js";
export {
  ClaudeBrain,
  buildClaudeRequest,
  parseClaudeResponse,
  DEFAULT_CLAUDE_MODEL,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  PROPOSE_ACTIONS_TOOL,
  type ClaudeBrainConfig,
  type AnthropicToolSpec,
  type AnthropicMessage,
  type AnthropicMessagesRequestBody,
  type AnthropicRequest,
  type AnthropicContentBlock,
  type AnthropicMessagesResponse,
} from "./claude.js";
export type {
  Action,
  Brain,
  Constitution,
  HealthReport,
  LedgerEntry,
  Money,
  MoneyCaps,
  OwnerMessage,
  RelayRequest,
  SessionInput,
  StepResult,
  ToolSpec,
  Turn,
  Usage,
  WorkOrder,
} from "./types.js";
