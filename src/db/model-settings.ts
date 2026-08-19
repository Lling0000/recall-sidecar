import type { ModelConfiguration } from "../model/types.js";
import type { DatabaseCore } from "./core.js";
import { now, row } from "./helpers.js";

export class ModelSettingsStore {
  constructor(private readonly core: DatabaseCore) {}

  getConfiguration(): ModelConfiguration | null {
    const value = this.core.getSetting("model_configuration");
    if (!value) return null;
    const parsed = JSON.parse(value) as ModelConfiguration & {
      refiner_model?: string;
    };
    return {
      ...parsed,
      refiner_model: parsed.refiner_model || parsed.model,
    };
  }

  saveConfiguration(configuration: ModelConfiguration): void {
    this.core.transaction(() => {
      this.put("model_configuration", JSON.stringify(configuration));
      this.put("strict_schema_verified", "false");
      this.put("auto_extract", "false");
      this.put("prompt_consent", "false");
      this.put("final_answer_consent", "false");
      this.put("consent_origin", "");
      this.put("verified_model_origin", "");
      this.put("verified_model_name", "");
      this.put("verified_refiner_model_name", "");
    });
  }

  markStrictSchemaVerified(origin: string, model: string, refinerModel = model): void {
    this.core.transaction(() => {
      this.put("strict_schema_verified", "true");
      this.put("verified_model_origin", origin);
      this.put("verified_model_name", model);
      this.put("verified_refiner_model_name", refinerModel);
      this.put("schema_verified_at", now());
    });
  }

  enableExtraction(origin: string, model: string, refinerModel = model): void {
    this.core.transaction(() => {
      if (
        this.value("strict_schema_verified") !== "true" ||
        this.value("verified_model_origin") !== origin ||
        this.value("verified_model_name") !== model ||
        this.value("verified_refiner_model_name") !== refinerModel ||
        this.value("consent_origin") !== origin ||
        this.value("prompt_consent") !== "true" ||
        this.value("final_answer_consent") !== "true"
      ) {
        throw new Error("strict_schema_or_consent_missing");
      }
      this.put("auto_extract", "true");
    });
  }

  setConsent(origin: string, prompt: boolean, finalAnswer: boolean): void {
    this.core.transaction(() => {
      this.put("prompt_consent", String(prompt));
      this.put("final_answer_consent", String(finalAnswer));
      this.put("consent_origin", origin);
      this.put("consent_at", now());
      if (!prompt || !finalAnswer) this.put("auto_extract", "false");
    });
  }

  pauseExtraction(): void {
    this.core.setSetting("auto_extract", "false");
  }

  reserveAttempt(limit: number): boolean {
    return this.core.transaction(() => {
      const date = new Date().toISOString().slice(0, 10);
      const storedDate = this.value("model_usage_date");
      const count = storedDate === date ? Number(this.value("model_usage_count")) : 0;
      if (!Number.isFinite(count) || count >= limit) return false;
      this.put("model_usage_date", date);
      this.put("model_usage_count", String(count + 1));
      return true;
    });
  }

  recordFailure(code: string): void {
    this.core.transaction(() => {
      this.put("model_last_error", code);
      this.put("model_last_error_at", now());
    });
  }

  clearFailure(): void {
    this.core.transaction(() => {
      this.put("model_last_error", "");
      this.put("model_last_error_at", "");
    });
  }

  private value(key: string): string | null {
    return (
      row<{ value: string }>(
        this.core.db.prepare("SELECT value FROM settings WHERE key=?").get(key),
      )?.value ?? null
    );
  }

  private put(key: string, value: string): void {
    this.core.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
}
