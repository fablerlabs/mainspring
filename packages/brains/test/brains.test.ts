import assert from "node:assert/strict";
import { test } from "node:test";

import { MockBrain } from "../src/mock.js";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  ClaudeBrain,
  DEFAULT_CLAUDE_MODEL,
  PROPOSE_ACTIONS_TOOL,
  buildClaudeRequest,
  parseClaudeResponse,
} from "../src/claude.js";
import type { Constitution, SessionInput, StepResult, Turn } from "../src/types.js";

function sampleConstitution(): Constitution {
  return {
    name: "Test Business",
    mission: "ship digital products",
    hardRules: ["Legal and honest only.", "You are an AI and never claim otherwise."],
    moneyCaps: { perSessionUsd: 25, notifyAboveUsd: 25, approvalAboveUsd: 75 },
    maxSessionMs: 40 * 60 * 1000,
  };
}

function sampleInput(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    constitution: sampleConstitution(),
    state: "# STATE\n\nDay 1.",
    journalTail: "- did nothing yet",
    ledgerTail: [],
    inbox: [],
    health: { ok: true, lastSessionFailed: false, notes: [] },
    pendingRelay: [],
    queue: [],
    tools: [{ name: "web_search", description: "search the web", argsSchema: { type: "object" } }],
    budget: { remainingUSD: 200, sessionMs: 40 * 60 * 1000 },
    ...overrides,
  };
}

// --- MockBrain ---------------------------------------------------------

test("MockBrain returns scripted StepResults in order", async () => {
  const script: StepResult[] = [
    { actions: [{ kind: "done" }], usage: { inputTokens: 0, outputTokens: 0, wallMs: 0 }, done: true },
    { actions: [], usage: { inputTokens: 1, outputTokens: 1, wallMs: 1 }, done: false },
  ];
  const brain = new MockBrain(script);

  const first = await brain.step(sampleInput(), []);
  const second = await brain.step(sampleInput(), []);

  assert.equal(first, script[0]);
  assert.equal(second, script[1]);
});

test("MockBrain throws once the script is exhausted", async () => {
  const brain = new MockBrain([{ actions: [], usage: { inputTokens: 0, outputTokens: 0, wallMs: 0 }, done: true }]);
  await brain.step(sampleInput(), []);
  await assert.rejects(() => brain.step(sampleInput(), []));
});

test("MockBrain records every SessionInput (and history) it receives", async () => {
  const brain = new MockBrain([
    { actions: [], usage: { inputTokens: 0, outputTokens: 0, wallMs: 0 }, done: false },
    { actions: [], usage: { inputTokens: 0, outputTokens: 0, wallMs: 0 }, done: true },
  ]);
  const inputA = sampleInput({ state: "state A" });
  const inputB = sampleInput({ state: "state B" });
  const history: Turn[] = [{ role: "loop", content: "hi", at: "2026-01-01T00:00:00.000Z" }];

  await brain.step(inputA, history);
  await brain.step(inputB, []);

  assert.equal(brain.received.length, 2);
  assert.equal(brain.received[0].input.state, "state A");
  assert.deepEqual(brain.received[0].history, history);
  assert.equal(brain.received[1].input.state, "state B");
  assert.deepEqual(brain.received[1].history, []);
});

// --- ClaudeBrain: request builder ---------------------------------------

test("buildClaudeRequest hits the Anthropic Messages endpoint with the right headers", () => {
  const { url, headers } = buildClaudeRequest(sampleInput(), [], { apiKey: "sk-test-key" });

  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(url, ANTHROPIC_MESSAGES_URL);
  assert.equal(headers["x-api-key"], "sk-test-key");
  assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(headers["content-type"], "application/json");
});

test("buildClaudeRequest never sees an apiKey except through config", () => {
  const { headers } = buildClaudeRequest(sampleInput(), [], { apiKey: "sk-explicit-only" });
  assert.equal(headers["x-api-key"], "sk-explicit-only");
});

test("buildClaudeRequest defaults to the placeholder model id, and honors an explicit one", () => {
  const defaultBody = buildClaudeRequest(sampleInput(), [], { apiKey: "sk-test-key" }).body;
  assert.equal(defaultBody.model, DEFAULT_CLAUDE_MODEL);

  const explicitBody = buildClaudeRequest(sampleInput(), [], { apiKey: "sk-test-key", model: "claude-sonnet-x" }).body;
  assert.equal(explicitBody.model, "claude-sonnet-x");
});

test("buildClaudeRequest carries the system prompt from config and turns history into prior messages", () => {
  const history: Turn[] = [
    { role: "loop", content: "session start", at: "2026-01-01T00:00:00.000Z" },
    { role: "brain", content: "ack", at: "2026-01-01T00:00:01.000Z" },
  ];
  const { body } = buildClaudeRequest(sampleInput(), history, {
    apiKey: "sk-test-key",
    systemPrompt: "You are the brain of a solo agent business.",
  });

  assert.equal(body.system, "You are the brain of a solo agent business.");
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[0], { role: "user", content: "session start" });
  assert.deepEqual(body.messages[1], { role: "assistant", content: "ack" });

  const last = body.messages[body.messages.length - 1];
  assert.equal(last.role, "user");
  assert.match(last.content, /Test Business/);
  assert.match(last.content, /Day 1\./);
});

test("buildClaudeRequest omits `system` from the body when no systemPrompt is configured", () => {
  const { body } = buildClaudeRequest(sampleInput(), [], { apiKey: "sk-test-key" });
  assert.equal("system" in body, false);
});

test("buildClaudeRequest registers propose_actions plus every tool from the SessionInput registry", () => {
  const { body } = buildClaudeRequest(sampleInput(), [], { apiKey: "sk-test-key" });
  const names = body.tools.map((t) => t.name);

  assert.ok(names.includes(PROPOSE_ACTIONS_TOOL));
  assert.ok(names.includes("web_search"));
  assert.equal(names.length, 2);
});

// --- ClaudeBrain: response parser ----------------------------------------

test("parseClaudeResponse maps a propose_actions tool_use block into a StepResult", () => {
  const result = parseClaudeResponse(
    {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: PROPOSE_ACTIONS_TOOL,
          input: {
            actions: [{ kind: "notify", to: "owner", text: "shipped a thing" }],
            done: true,
          },
        },
      ],
      usage: { input_tokens: 120, output_tokens: 40 },
    },
    250,
  );

  assert.equal(result.done, true);
  assert.deepEqual(result.actions, [{ kind: "notify", to: "owner", text: "shipped a thing" }]);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40, wallMs: 250 });
});

test("parseClaudeResponse maps any other tool_use block into a run Action", () => {
  const result = parseClaudeResponse(
    {
      content: [{ type: "tool_use", id: "tu_2", name: "web_search", input: { query: "gumroad alternatives" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    50,
  );

  assert.deepEqual(result.actions, [{ kind: "run", tool: "web_search", args: { query: "gumroad alternatives" } }]);
  assert.equal(result.done, false);
});

test("parseClaudeResponse ignores text blocks and defaults usage/done when absent", () => {
  const result = parseClaudeResponse({ content: [{ type: "text", text: "thinking out loud" }] }, 10);

  assert.deepEqual(result.actions, []);
  assert.equal(result.done, false);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, wallMs: 10 });
});

// --- ClaudeBrain: construction --------------------------------------------

test("ClaudeBrain requires an apiKey and never reads one from the environment", () => {
  assert.throws(() => new ClaudeBrain({ apiKey: "" }));

  const brain = new ClaudeBrain({ apiKey: "sk-test-key" });
  assert.equal(brain.id, "claude");
  assert.equal(brain.model, DEFAULT_CLAUDE_MODEL);
});

test("ClaudeBrain.estimateCost reports $0 rather than guessing at pricing", () => {
  const brain = new ClaudeBrain({ apiKey: "sk-test-key" });
  assert.deepEqual(brain.estimateCost?.({ inputTokens: 1000, outputTokens: 1000, wallMs: 1000 }), { usd: 0 });
});
