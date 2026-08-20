import type { MemoryDatabase } from "../db/database.js";
import { createModelConfiguration } from "./configuration.js";
import { KnowledgeConsolidationClient } from "./consolidation-client.js";
import { ModelError } from "./error.js";
import { SessionRefineClient } from "./session-client.js";
import type { SessionGateInput } from "./session-types.js";
import type { ApiKeyProvider } from "./types.js";

export class ModelManager {
  readonly sessionClient: SessionRefineClient;
  readonly consolidationClient: KnowledgeConsolidationClient;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly keyProvider: ApiKeyProvider,
    sessionClient?: SessionRefineClient,
    consolidationClient?: KnowledgeConsolidationClient,
    private readonly onEnabled: () => void = () => undefined,
  ) {
    this.sessionClient = sessionClient ?? new SessionRefineClient();
    this.consolidationClient =
      consolidationClient ?? new KnowledgeConsolidationClient();
  }

  async configure(
    baseUrl: string,
    model: string,
    apiKey: string | null,
  ): Promise<void> {
    const configuration = createModelConfiguration(baseUrl, model);
    if (!apiKey && !(await this.keyProvider.get())) {
      throw new Error("api_key_required");
    }
    this.database.modelSettings.saveConfiguration(configuration);
    if (apiKey) {
      await this.keyProvider.delete();
      await this.keyProvider.set(apiKey);
    }
  }

  async testConnection(): Promise<{
    attempts: number;
    requestPreview: SessionGateInput;
  }> {
    const configuration = this.database.modelSettings.getConfiguration();
    const apiKey = await this.keyProvider.get();
    if (!configuration || !apiKey) throw new Error("model_not_configured");
    try {
      const requestPreview: SessionGateInput = {
        turns: [
          {
            turn_id: "connection-test-turn",
            user_prompt: "本项目确认：超时起点首次写入后，重复消息不得重置。",
            final_answer: "该约束已写入方案并通过验证。",
          },
        ],
        eligible_turn_ids: ["connection-test-turn"],
        active_memories: [],
      };
      const gate = await schemaStep("gate", () =>
        this.sessionClient.gate(configuration, apiKey, requestPreview),
      );
      const refined = await schemaStep("refiner", () =>
        this.sessionClient.refine(configuration, apiKey, {
          ...requestPreview,
          selected_turn_ids: ["connection-test-turn"],
        }),
      );
      const consolidated = await schemaStep("consolidation", () =>
        this.consolidationClient.consolidate(configuration, apiKey, {
          active_memories: [],
        }),
      );
      const origin = new URL(configuration.base_url).origin;
      this.database.modelSettings.markStrictSchemaVerified(origin, configuration.model);
      this.database.consolidations.clearResolvedFailures();
      this.database.modelSettings.clearFailure();
      return {
        attempts: gate.attempts + refined.attempts + consolidated.attempts,
        requestPreview,
      };
    } catch (error) {
      const code = error instanceof ModelError ? error.code : "schema_test_failed";
      this.database.modelSettings.recordFailure(code);
      this.database.modelSettings.pauseExtraction();
      throw error;
    }
  }

  enable(): void {
    const configuration = this.database.modelSettings.getConfiguration();
    if (!configuration) throw new Error("model_not_configured");
    const origin = new URL(configuration.base_url).origin;
    this.database.modelSettings.setConsent(origin, true, true);
    this.database.modelSettings.enableExtraction(origin, configuration.model);
    this.onEnabled();
  }

  pause(): void {
    const configuration = this.database.modelSettings.getConfiguration();
    if (!configuration) {
      this.database.modelSettings.pauseExtraction();
      return;
    }
    const origin = new URL(configuration.base_url).origin;
    this.database.modelSettings.setConsent(origin, false, false);
  }
}

async function schemaStep<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ModelError) {
      throw new ModelError(`${stage}_${error.code}`);
    }
    throw error;
  }
}
