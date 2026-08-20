export interface ModelConfiguration {
  provider: "openai-compatible";
  base_url: string;
  model: string;
  api_key_ref: "os-keychain://codex-local-memory/extract-api-key";
  timeout_ms: number;
  max_input_chars: number;
  max_output_tokens: number;
  max_response_bytes: number;
  max_retries: 1;
}

export interface ApiKeyProvider {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}
