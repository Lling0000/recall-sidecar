import { KEYCHAIN_REFERENCE } from "../constants.js";
import type { ModelConfiguration } from "./types.js";

export function createModelConfiguration(
  baseUrl: string,
  model: string,
): ModelConfiguration {
  const normalizedModel = model.trim();
  if (!normalizedModel || normalizedModel.length > 200) {
    throw new Error("invalid_model_name");
  }
  const url = validateBaseUrl(baseUrl);
  return {
    provider: "openai-compatible",
    base_url: url.href.replace(/\/$/u, ""),
    model: normalizedModel,
    api_key_ref: KEYCHAIN_REFERENCE,
    timeout_ms: 30_000,
    max_input_chars: 12_000,
    max_output_tokens: 1_000,
    max_response_bytes: 65_536,
    max_retries: 1,
    daily_extract_limit: 100,
  };
}

export function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_model_base_url");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("unsafe_model_base_url");
  }
  if (url.protocol !== "https:") {
    throw new Error("model_base_url_requires_https");
  }
  if (!url.hostname || url.pathname.includes("..")) {
    throw new Error("unsafe_model_base_url");
  }
  return url;
}

export function chatCompletionsUrl(configuration: ModelConfiguration): URL {
  const base = new URL(`${configuration.base_url}/`);
  return new URL("chat/completions", base);
}
