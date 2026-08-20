import {
  CONSOLIDATION_PROMPT,
  CONSOLIDATION_SCHEMA,
} from "./consolidation-contract.js";
import type { ConsolidationInput, ConsolidationResult } from "./consolidation-types.js";
import {
  prepareConsolidationInput,
  validateConsolidationResult,
} from "./consolidation-validation.js";
import {
  type FetchImplementation,
  StructuredModelTransport,
} from "./structured-transport.js";
import type { ModelConfiguration } from "./types.js";

export class KnowledgeConsolidationClient {
  private readonly transport: StructuredModelTransport;

  constructor(fetchImplementation: FetchImplementation = fetch) {
    this.transport = new StructuredModelTransport(fetchImplementation);
  }

  async consolidate(
    configuration: ModelConfiguration,
    apiKey: string,
    input: ConsolidationInput,
  ): Promise<{ result: ConsolidationResult; attempts: number }> {
    const prepared = prepareConsolidationInput(input);
    const response = await this.transport.call(
      configuration,
      apiKey,
      CONSOLIDATION_PROMPT,
      prepared,
      CONSOLIDATION_SCHEMA,
      "codex_local_memory_consolidation",
      Math.max(configuration.max_output_tokens, 4_000),
    );
    return {
      result: validateConsolidationResult(response.value, prepared),
      attempts: response.attempts,
    };
  }
}
