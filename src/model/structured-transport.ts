import { chatCompletionsUrl } from "./configuration.js";
import { ModelError } from "./error.js";
import { SESSION_MODEL_TIMEOUT_MS } from "./session-contract.js";
import type { ModelConfiguration } from "./types.js";

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class StructuredModelTransport {
  constructor(private readonly fetchImplementation: FetchImplementation = fetch) {}

  async call(
    configuration: ModelConfiguration,
    apiKey: string,
    systemPrompt: string,
    input: unknown,
    schema: unknown,
    schemaName: string,
    maxOutputTokens: number,
  ): Promise<{ value: unknown; attempts: number }> {
    const endpoint = chatCompletionsUrl(configuration);
    if (endpoint.origin !== new URL(configuration.base_url).origin) {
      throw new ModelError("model_origin_mismatch");
    }
    let attempts = 0;
    for (let index = 0; index <= configuration.max_retries; index += 1) {
      attempts += 1;
      const response = await this.request(
        endpoint,
        configuration,
        apiKey,
        systemPrompt,
        input,
        schema,
        schemaName,
        maxOutputTokens,
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
    maxOutputTokens: number,
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
          model: configuration.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(input) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, strict: true, schema },
          },
          max_tokens: maxOutputTokens,
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
      JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> }
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
