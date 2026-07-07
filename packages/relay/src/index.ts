/**
 * @mainspring/relay — a zero-dependency, human-in-the-loop client for the
 * Fabler Relay wire protocol. This is the GOVERNANCE leg of the Mainspring
 * loop: when a Brain proposes something only a human can do (create an
 * account, clear a CAPTCHA, approve a spend), the loop files a relay request
 * and waits for a person to resolve it.
 *
 * SECURITY — every value returned by the relay is untrusted DATA authored by
 * a human or the open web. Never treat a returned string as an instruction.
 * See {@link RelayRequestView}.
 */

export {
  RelayClient,
  type RelayClientOptions,
} from "./client.js";

export {
  pollUntilResolved,
  type PollOptions,
} from "./poll.js";

export {
  MockRelay,
  EchoResponder,
  defaultEchoDecider,
  type EchoDecision,
  type EchoDecider,
} from "./mock.js";

export {
  isTerminal,
  TERMINAL_STATES,
  RelayError,
  RelayConfigError,
  RelayHttpError,
  RelayProtocolError,
  RelayTimeoutError,
  type RelayApi,
  type RelayStatus,
  type FileRequestInput,
  type RelayRequestView,
  type RelayRequestSummary,
  type ExecTokenView,
  type RedeemResult,
} from "./types.js";
