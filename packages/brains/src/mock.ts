import type { Brain, SessionInput, StepResult, Turn } from "./types.js";

/**
 * A scripted, deterministic Brain for tests and examples. Constructed with an
 * ordered array of `StepResult`s, it returns one per `step()` call and
 * records every `SessionInput` (and accompanying history) it was handed, so
 * a test can assert on exactly what the loop assembled and gave the brain.
 */
export class MockBrain implements Brain {
  readonly id = "mock";
  readonly model = "mock-scripted";

  readonly received: Array<{ input: SessionInput; history: Turn[] }> = [];

  private readonly script: StepResult[];
  private cursor = 0;

  constructor(script: StepResult[]) {
    this.script = script;
  }

  async step(input: SessionInput, history: Turn[]): Promise<StepResult> {
    this.received.push({ input, history });

    if (this.cursor >= this.script.length) {
      throw new Error(
        `MockBrain: step() was called ${this.cursor + 1} times but only ${this.script.length} scripted StepResult(s) were provided`,
      );
    }

    return this.script[this.cursor++];
  }
}
