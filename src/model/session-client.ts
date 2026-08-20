import {
  GATE_MAX_INPUT_CHARS,
  GATE_PROMPT,
  GATE_SCHEMA,
  REFINER_MAX_INPUT_CHARS,
  REFINER_PROMPT,
  REFINER_SCHEMA,
} from "./session-contract.js";
import type {
  SessionGateInput,
  SessionGateResult,
  SessionRefinerInput,
  SessionRefinerResult,
} from "./session-types.js";
import {
  prepareSessionInput,
  validateGateResult,
  validateRefinerResult,
} from "./session-validation.js";
import {
  type FetchImplementation,
  StructuredModelTransport,
} from "./structured-transport.js";
import type { ModelConfiguration } from "./types.js";

export class SessionRefineClient {
  private readonly transport: StructuredModelTransport;

  constructor(fetchImplementation: FetchImplementation = fetch) {
    this.transport = new StructuredModelTransport(fetchImplementation);
  }

  async gate(
    configuration: ModelConfiguration,
    apiKey: string,
    input: SessionGateInput,
  ): Promise<{
    result: SessionGateResult;
    attempts: number;
    considered_turn_ids: string[];
  }> {
    const prepared = prepareSessionInput(input, GATE_MAX_INPUT_CHARS);
    const response = await this.transport.call(
      configuration,
      apiKey,
      GATE_PROMPT,
      prepared,
      GATE_SCHEMA,
      "codex_local_memory_gate",
      Math.min(configuration.max_output_tokens, 500),
    );
    return {
      result: validateGateResult(response.value, prepared.eligible_turn_ids),
      attempts: response.attempts,
      considered_turn_ids: [...prepared.eligible_turn_ids],
    };
  }

  async refine(
    configuration: ModelConfiguration,
    apiKey: string,
    input: SessionRefinerInput,
  ): Promise<{ result: SessionRefinerResult; attempts: number }> {
    const prepared = {
      ...prepareSessionInput(input, REFINER_MAX_INPUT_CHARS),
      selected_turn_ids: [...input.selected_turn_ids],
    };
    const response = await this.transport.call(
      configuration,
      apiKey,
      REFINER_PROMPT,
      prepared,
      REFINER_SCHEMA,
      "codex_local_memory_refiner",
      Math.max(configuration.max_output_tokens, 4_000),
    );
    return {
      result: validateRefinerResult(response.value, prepared),
      attempts: response.attempts,
    };
  }
}
