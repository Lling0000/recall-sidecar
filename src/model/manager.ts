import type { MemoryDatabase } from "../db/database.js";
import { ModelError, StrictModelClient } from "./client.js";
import { createModelConfiguration } from "./configuration.js";
import type { ApiKeyProvider, ExtractionInput, ModelCallResult } from "./types.js";

const CONNECTION_TEST_INPUT: ExtractionInput = {
  user_prompt: "No durable correction is requested in this connection test.",
  final_answer: "Connection test acknowledged.",
  compare_cards: [],
};

export class ModelManager {
  readonly client: StrictModelClient;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly keyProvider: ApiKeyProvider,
    client?: StrictModelClient,
  ) {
    this.client = client ?? new StrictModelClient(this.database.modelSettings);
  }

  async configure(
    baseUrl: string,
    model: string,
    apiKey: string | null,
    allowLoopbackHttp = false,
  ): Promise<void> {
    const configuration = createModelConfiguration(baseUrl, model, allowLoopbackHttp);
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
      const origin = new URL(configuration.base_url).origin;
      this.database.modelSettings.markStrictSchemaVerified(origin, configuration.model);
      this.database.modelSettings.clearFailure();
      return result;
    } catch (error) {
      const code = error instanceof ModelError ? error.code : "schema_test_failed";
      this.database.modelSettings.recordFailure(code);
      this.database.modelSettings.pauseExtraction();
      throw error;
    }
  }

  enable(promptConsent: boolean, finalAnswerConsent: boolean): void {
    const configuration = this.database.modelSettings.getConfiguration();
    if (!configuration) throw new Error("model_not_configured");
    const origin = new URL(configuration.base_url).origin;
    this.database.modelSettings.setConsent(origin, promptConsent, finalAnswerConsent);
    this.database.modelSettings.enableExtraction(origin, configuration.model);
  }

  pause(): void {
    this.database.modelSettings.pauseExtraction();
  }
}
