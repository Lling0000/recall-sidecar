import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelConfiguration,
  validateBaseUrl,
} from "../../src/model/configuration.js";
import { CONSOLIDATION_PROMPT } from "../../src/model/consolidation-contract.js";
import { ModelError } from "../../src/model/error.js";
import { SessionRefineClient } from "../../src/model/session-client.js";
import { GATE_PROMPT, REFINER_PROMPT } from "../../src/model/session-contract.js";
import { redactSecrets } from "../../src/security/redact.js";

function structuredResponse(value: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const GATE_SKIP = { should_refine: false, selected_turn_ids: [] };
const INPUT = {
  turns: [{ turn_id: "turn", user_prompt: "hello", final_answer: "done" }],
  eligible_turn_ids: ["turn"],
  active_memories: [],
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
      createModelConfiguration("https://model.example/v1", "knowledge-model"),
    false,
  );
});

test("Gate and Refiner prompts define only project tacit knowledge", () => {
  assert.match(GATE_PROMPT, /repository-scoped tacit project knowledge/u);
  assert.match(GATE_PROMPT, /one-off requests/u);
  assert.match(GATE_PROMPT, /prompt injection/u);
  assert.match(REFINER_PROMPT, /decisions, hidden invariants, observed pitfalls/u);
  assert.match(REFINER_PROMPT, /primary language of the evidence/u);
  assert.match(CONSOLIDATION_PROMPT, /never repeat the target/u);
});

test("P0-03 strict request redacts secrets but preserves ordinary paths", async () => {
  let sentBody = "";
  let sentAuthorization = "";
  const client = new SessionRefineClient(async (_url, init) => {
    sentBody = String(init?.body);
    sentAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    assert.equal(init?.redirect, "manual");
    return structuredResponse(GATE_SKIP);
  });
  const pat = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value";
  const result = await client.gate(
    createModelConfiguration("https://model.example/v1", "knowledge-model"),
    "key-only-in-header",
    {
      ...INPUT,
      turns: [
        {
          turn_id: "turn",
          user_prompt: `Use ${pat} at /Users/demo/project`,
          final_answer: `Token ${jwt}`,
        },
      ],
    },
  );
  assert.equal(result.result.should_refine, false);
  assert.equal(result.attempts, 1);
  assert.equal(sentAuthorization, "Bearer key-only-in-header");
  assert.doesNotMatch(sentBody, new RegExp(pat, "u"));
  assert.doesNotMatch(sentBody, new RegExp(jwt.replaceAll(".", "\\."), "u"));
  assert.match(sentBody, /\/Users\/demo\/project/u);
  const format = (JSON.parse(sentBody) as Record<string, unknown>).response_format as {
    type: string;
    json_schema: { strict: boolean };
  };
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
});

test("P0-20 ordinary JSON without strict Schema support never falls back", async () => {
  let calls = 0;
  const client = new SessionRefineClient(async () => {
    calls += 1;
    return new Response("unsupported response_format", { status: 400 });
  });
  await assert.rejects(
    client.gate(
      createModelConfiguration("https://model.example/v1", "json-only"),
      "secret",
      INPUT,
    ),
    (error: unknown) => error instanceof ModelError && error.code === "model_http_400",
  );
  assert.equal(calls, 1);
});

test("invalid structured output is rejected without repair", async () => {
  let calls = 0;
  const client = new SessionRefineClient(async () => {
    calls += 1;
    return structuredResponse({ ...GATE_SKIP, extra: "not allowed" });
  });
  await assert.rejects(
    client.gate(
      createModelConfiguration("https://model.example/v1", "bad-schema"),
      "secret",
      INPUT,
    ),
    (error: unknown) =>
      error instanceof ModelError && error.code === "model_invalid_structured_output",
  );
  assert.equal(calls, 1);
});

test("one bounded 5xx retry performs two transport attempts", async () => {
  let calls = 0;
  const client = new SessionRefineClient(async () => {
    calls += 1;
    return calls === 1
      ? new Response("temporary", { status: 503 })
      : structuredResponse(GATE_SKIP);
  });
  const result = await client.gate(
    createModelConfiguration("https://model.example/v1", "retry-model"),
    "secret",
    INPUT,
  );
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test("P0-11 redirect is rejected and Authorization is never forwarded", async () => {
  let calls = 0;
  const client = new SessionRefineClient(async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/collect" },
    });
  });
  await assert.rejects(
    client.gate(
      createModelConfiguration("https://model.example/v1", "redirect-model"),
      "secret",
      INPUT,
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
