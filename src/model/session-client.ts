import { type AttemptBudget, ModelError } from "./client.js";
import { chatCompletionsUrl } from "./configuration.js";
import {
  GATE_MAX_INPUT_CHARS,
  GATE_PROMPT,
  GATE_SCHEMA,
  REFINER_MAX_INPUT_CHARS,
  REFINER_PROMPT,
  REFINER_SCHEMA,
  SESSION_MODEL_TIMEOUT_MS,
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
import type { ModelConfiguration } from "./types.js";

type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class SessionRefineClient {
  constructor(
    private readonly budget: AttemptBudget,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async gate(
    configuration: ModelConfiguration,
    apiKey: string,
    input: SessionGateInput,
  ): Promise<{ result: SessionGateResult; attempts: number }> {
    const prepared = prepareSessionInput(input, GATE_MAX_INPUT_CHARS);
    const response = await this.call(
      configuration,
      apiKey,
      GATE_PROMPT,
      prepared,
      GATE_SCHEMA,
      "codex_local_memory_gate",
    );
    return {
      result: validateGateResult(response.value, prepared.candidates),
      attempts: response.attempts,
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
    const response = await this.call(
      configuration,
      apiKey,
      REFINER_PROMPT,
      prepared,
      REFINER_SCHEMA,
      "codex_local_memory_refiner",
    );
    return {
      result: validateRefinerResult(response.value, prepared),
      attempts: response.attempts,
    };
  }

  private async call(
    configuration: ModelConfiguration,
    apiKey: string,
    systemPrompt: string,
    input: unknown,
    schema: unknown,
    schemaName: string,
  ): Promise<{ value: unknown; attempts: number }> {
    const endpoint = chatCompletionsUrl(configuration);
    if (endpoint.origin !== new URL(configuration.base_url).origin) {
      throw new ModelError("model_origin_mismatch");
    }
    let attempts = 0;
    for (let index = 0; index <= configuration.max_retries; index += 1) {
      if (!this.budget.reserveAttempt(configuration.daily_extract_limit)) {
        throw new ModelError("daily_extract_limit_reached");
      }
      attempts += 1;
      const response = await this.request(
        endpoint,
        configuration,
        apiKey,
        systemPrompt,
        input,
        schema,
        schemaName,
      );
      if (
        (response.status === 429 || response.status >= 500) &&
        index < configuration.max_retries
      ) {
        await waitForRetry(response.headers.get("retry-after"));
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ModelError("model_redirect_rejected");
      }
      if (!response.ok) throw new ModelError(`model_http_${response.status}`);
      const body = await readLimitedBody(response, configuration.max_response_bytes);
      const content = extractMessageContent(body);
      try {
        return { value: JSON.parse(content) as unknown, attempts };
      } catch {
        throw new ModelError("model_invalid_structured_output");
      }
    }
    throw new ModelError("model_retry_exhausted");
  }

  private async request(
    endpoint: URL,
    configuration: ModelConfiguration,
    apiKey: string,
    systemPrompt: string,
    input: unknown,
    schema: unknown,
    schemaName: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(configuration.timeout_ms, SESSION_MODEL_TIMEOUT_MS),
    );
    try {
      return await this.fetchImplementation(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: configuration.refiner_model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(input) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, strict: true, schema },
          },
          max_tokens: schemaName.endsWith("_gate")
            ? Math.min(configuration.max_output_tokens, 500)
            : Math.max(configuration.max_output_tokens, 4_000),
        }),
      });
    } catch {
      if (controller.signal.aborted) throw new ModelError("model_timeout");
      throw new ModelError("model_transport_error");
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new ModelError("model_empty_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) throw new ModelError("model_response_too_large");
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result + decoder.decode();
}

function extractMessageContent(body: string): string {
  try {
    const content = (
      JSON.parse(body) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      }
    ).choices?.[0]?.message?.content;
    if (typeof content === "string" && content.length > 0) return content;
  } catch {
    throw new ModelError("model_invalid_response_json");
  }
  throw new ModelError("model_missing_structured_output");
}

async function waitForRetry(header: string | null): Promise<void> {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds <= 0) return;
  await new Promise<void>((resolve) =>
    setTimeout(resolve, Math.min(seconds * 1_000, 2_000)),
  );
}
