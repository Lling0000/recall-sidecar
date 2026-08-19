import type { MemoryDatabase } from "../db/database.js";
import { ModelError, StrictModelClient } from "./client.js";
import { createModelConfiguration } from "./configuration.js";
import { SessionRefineClient } from "./session-client.js";
import type { ApiKeyProvider, ExtractionInput, ModelCallResult } from "./types.js";

const CONNECTION_TEST_INPUT: ExtractionInput = {
  user_prompt: "No durable correction is requested in this connection test.",
  final_answer: "Connection test acknowledged.",
  compare_cards: [],
};

export class ModelManager {
  readonly client: StrictModelClient;
  readonly sessionClient: SessionRefineClient;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly keyProvider: ApiKeyProvider,
    client?: StrictModelClient,
    sessionClient?: SessionRefineClient,
  ) {
    this.client = client ?? new StrictModelClient(this.database.modelSettings);
    this.sessionClient =
      sessionClient ?? new SessionRefineClient(this.database.modelSettings);
  }

  async configure(
    baseUrl: string,
    model: string,
    apiKey: string | null,
    refinerModel = model,
  ): Promise<void> {
    const configuration = createModelConfiguration(baseUrl, model, refinerModel);
    if (!apiKey && !(await this.keyProvider.get())) {
      throw new Error("api_key_required");
    }
    this.database.modelSettings.saveConfiguration(configuration);
    if (apiKey) {
      await this.keyProvider.delete();
      await this.keyProvider.set(apiKey);
    }
  }

  async testConnection(): Promise<ModelCallResult> {
    const configuration = this.database.modelSettings.getConfiguration();
    const apiKey = await this.keyProvider.get();
    if (!configuration || !apiKey) throw new Error("model_not_configured");
    try {
      const result = await this.client.extract(
        configuration,
        apiKey,
        CONNECTION_TEST_INPUT,
      );
      await this.sessionClient.gate(configuration, apiKey, {
        turns: [
          {
            turn_id: "connection-test-turn",
            user_prompt: "This is a one-off connection test.",
            final_answer: "Connection test acknowledged.",
          },
        ],
        candidates: [
          {
            job_id: "connection-test-job",
            turn_id: "connection-test-turn",
            action: "skip",
            target_memory_id: null,
            base_version: null,
            memory: null,
          },
        ],
        active_memories: [],
      });
      await this.sessionClient.refine(configuration, apiKey, {
        turns: [
          {
            turn_id: "connection-test-turn",
            user_prompt: "This is a one-off connection test.",
            final_answer: "Connection test acknowledged.",
          },
        ],
        candidates: [
          {
            job_id: "connection-test-job",
            turn_id: "connection-test-turn",
            action: "skip",
            target_memory_id: null,
            base_version: null,
            memory: null,
          },
        ],
        active_memories: [],
        selected_turn_ids: ["connection-test-turn"],
      });
      const origin = new URL(configuration.base_url).origin;
      this.database.modelSettings.markStrictSchemaVerified(
        origin,
        configuration.model,
        configuration.refiner_model,
      );
      this.database.modelSettings.clearFailure();
      return result;
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
    this.database.modelSettings.enableExtraction(
      origin,
      configuration.model,
      configuration.refiner_model,
    );
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
