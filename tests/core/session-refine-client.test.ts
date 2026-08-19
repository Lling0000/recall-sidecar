import assert from "node:assert/strict";
import test from "node:test";
import { createModelConfiguration } from "../../src/model/configuration.js";
import { SessionRefineClient } from "../../src/model/session-client.js";

function response(value: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
    { status: 200 },
  );
}

const CARD = {
  title: "长期规则",
  wrong_behavior: "只用于当前任务",
  correct_behavior: "后续同类工作继续遵守该规则。",
  applicability: "本仓库",
};

test("Gate and Refiner use the configured higher-tier model with strict schemas", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = new SessionRefineClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const name = (body.response_format as { json_schema: { name: string } }).json_schema
      .name;
    return response(
      name.endsWith("_gate")
        ? { should_refine: true, candidate_turn_ids: ["turn-1"] }
        : {
            edits: [
              {
                action: "create",
                source_turn_id: "turn-1",
                target_memory_id: null,
                base_version: null,
                memory: CARD,
              },
            ],
          },
    );
  });
  const configuration = createModelConfiguration(
    "https://model.example/v1",
    "candidate-model",
    "refiner-model",
  );
  const input = {
    turns: [
      {
        turn_id: "turn-1",
        user_prompt: "以后遵守该规则 github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        final_answer: "已处理。",
      },
    ],
    candidates: [
      {
        job_id: "job-1",
        turn_id: "turn-1",
        action: "create" as const,
        target_memory_id: null,
        base_version: null,
        memory: CARD,
      },
    ],
    active_memories: [],
  };
  const gate = await client.gate(configuration, "secret", input);
  assert.deepEqual(gate.result.candidate_turn_ids, ["turn-1"]);
  const refined = await client.refine(configuration, "secret", {
    ...input,
    selected_turn_ids: gate.result.candidate_turn_ids,
  });
  assert.equal(refined.result.edits[0]?.action, "create");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, "refiner-model");
    assert.equal(
      (
        request.response_format as {
          type: string;
          json_schema: { strict: boolean };
        }
      ).json_schema.strict,
      true,
    );
    assert.doesNotMatch(JSON.stringify(request), /github_pat_/u);
  }
});
