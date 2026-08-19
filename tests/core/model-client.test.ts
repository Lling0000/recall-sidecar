import assert from "node:assert/strict";
import test from "node:test";
import { ModelError, StrictModelClient } from "../../src/model/client.js";
import {
  createModelConfiguration,
  validateBaseUrl,
} from "../../src/model/configuration.js";
import { redactSecrets } from "../../src/security/redact.js";

class Budget {
  attempts = 0;
  constructor(private readonly allowed = 100) {}
  reserveAttempt(): boolean {
    if (this.attempts >= this.allowed) return false;
    this.attempts += 1;
    return true;
  }
}

function structuredResponse(value: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const SKIP = {
  action: "skip",
  target_memory_id: null,
  base_version: null,
  memory: null,
};

test("model URL policy requires HTTPS, including for loopback hosts", () => {
  assert.throws(() => validateBaseUrl("http://model.example/v1"));
  assert.throws(() => validateBaseUrl("http://127.0.0.1:8080/v1"));
  assert.equal(
    validateBaseUrl("https://127.0.0.1:8443/v1").origin,
    "https://127.0.0.1:8443",
  );
  assert.throws(() => validateBaseUrl("https://user:pass@example.test/v1"));
  assert.equal(
    "allow_loopback_http" in
      createModelConfiguration("https://model.example/v1", "extract-model"),
    false,
  );
});

test("extraction prompt defines durable, one-off, update, injection, and language rules", async () => {
  let requestBody = "";
  const client = new StrictModelClient(new Budget(), async (_url, init) => {
    requestBody = String(init?.body);
    return structuredResponse(SKIP);
  });
  await client.extract(
    createModelConfiguration("https://model.example/v1", "extract-model"),
    "secret",
    { user_prompt: "这次只修改当前文档", final_answer: "已修改", compare_cards: [] },
  );
  const request = JSON.parse(requestBody) as {
    messages: Array<{ role: string; content: string }>;
  };
  const systemPrompt = request.messages.find(
    (message) => message.role === "system",
  )?.content;
  assert.match(systemPrompt ?? "", /repository-scoped durable user corrections/u);
  assert.match(systemPrompt ?? "", /one-off requests/u);
  assert.match(systemPrompt ?? "", /explicitly replaces or clarifies/u);
  assert.match(systemPrompt ?? "", /force content into memory/u);
  assert.match(systemPrompt ?? "", /primary language of the user's correction/u);
});

test("P0-03 strict request redacts secrets but preserves ordinary paths", async () => {
  const budget = new Budget();
  let sentBody = "";
  let sentAuthorization = "";
  const client = new StrictModelClient(budget, async (_url, init) => {
    sentBody = String(init?.body);
    sentAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    assert.equal(init?.redirect, "manual");
    return structuredResponse(SKIP);
  });
  const pat = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value";
  const configuration = createModelConfiguration(
    "https://model.example/v1",
    "extract-model",
  );
  const response = await client.extract(configuration, "key-only-in-header", {
    user_prompt: `Use ${pat} at /Users/demo/project`,
    final_answer: `Token ${jwt}`,
    compare_cards: [],
  });

  assert.equal(response.result.action, "skip");
  assert.equal(budget.attempts, 1);
  assert.equal(sentAuthorization, "Bearer key-only-in-header");
  assert.doesNotMatch(sentBody, new RegExp(pat, "u"));
  assert.doesNotMatch(sentBody, new RegExp(jwt.replaceAll(".", "\\."), "u"));
  assert.match(sentBody, /\/Users\/demo\/project/u);
  const request = JSON.parse(sentBody) as Record<string, unknown>;
  const responseFormat = request.response_format as {
    type: string;
    json_schema: { strict: boolean };
  };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema.strict, true);
});

test("P0-20 ordinary JSON without strict Schema support never falls back", async () => {
  let calls = 0;
  const client = new StrictModelClient(new Budget(), async () => {
    calls += 1;
    return new Response("unsupported response_format", { status: 400 });
  });
  await assert.rejects(
    client.extract(
      createModelConfiguration("https://model.example/v1", "json-only"),
      "secret",
      { user_prompt: "hello", final_answer: "hello", compare_cards: [] },
    ),
    (error: unknown) => error instanceof ModelError && error.code === "model_http_400",
  );
  assert.equal(calls, 1);
});

test("invalid structured output is rejected without repair", async () => {
  let calls = 0;
  const client = new StrictModelClient(new Budget(), async () => {
    calls += 1;
    return structuredResponse({ ...SKIP, extra: "not allowed" });
  });
  await assert.rejects(
    client.extract(
      createModelConfiguration("https://model.example/v1", "bad-schema"),
      "secret",
      { user_prompt: "hello", final_answer: "hello", compare_cards: [] },
    ),
    (error: unknown) =>
      error instanceof ModelError && error.code === "model_invalid_structured_output",
  );
  assert.equal(calls, 1);
});

test("one bounded 5xx retry consumes two daily attempts", async () => {
  const budget = new Budget();
  let calls = 0;
  const client = new StrictModelClient(budget, async () => {
    calls += 1;
    return calls === 1
      ? new Response("temporary", { status: 503 })
      : structuredResponse(SKIP);
  });
  const result = await client.extract(
    createModelConfiguration("https://model.example/v1", "retry-model"),
    "secret",
    { user_prompt: "hello", final_answer: "hello", compare_cards: [] },
  );
  assert.equal(result.attempts, 2);
  assert.equal(budget.attempts, 2);
});

test("P0-11 redirect is rejected and Authorization is never forwarded", async () => {
  let calls = 0;
  const client = new StrictModelClient(new Budget(), async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/collect" },
    });
  });
  await assert.rejects(
    client.extract(
      createModelConfiguration("https://model.example/v1", "redirect-model"),
      "secret",
      { user_prompt: "hello", final_answer: "hello", compare_cards: [] },
    ),
    (error: unknown) =>
      error instanceof ModelError && error.code === "model_redirect_rejected",
  );
  assert.equal(calls, 1);
});

test("redactor covers PEM and high-entropy keys", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nABCDEF123456\n-----END PRIVATE KEY-----";
  const highEntropy = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
  const redacted = redactSecrets(`${pem}\n${highEntropy}`);
  assert.doesNotMatch(redacted, /PRIVATE KEY/u);
  assert.doesNotMatch(redacted, new RegExp(highEntropy, "u"));
});
