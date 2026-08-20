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
  kind: "lesson" as const,
  title: "项目经验",
  knowledge: "后续同类工作继续遵守该项目经验。",
  rationale: "该结论来自本项目的实际工作结果。",
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
        ? { should_refine: true, selected_turn_ids: ["turn-1"] }
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
    "knowledge-model",
  );
  const input = {
    turns: [
      {
        turn_id: "turn-1",
        user_prompt: "以后遵守该规则 github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        final_answer: "已处理。",
      },
    ],
    eligible_turn_ids: ["turn-1"],
    active_memories: [],
  };
  const gate = await client.gate(configuration, "secret", input);
  assert.deepEqual(gate.result.selected_turn_ids, ["turn-1"]);
  const refined = await client.refine(configuration, "secret", {
    ...input,
    selected_turn_ids: gate.result.selected_turn_ids,
  });
  assert.equal(refined.result.edits[0]?.action, "create");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, "knowledge-model");
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

test("Gate rejects a context-only overlap turn as a knowledge source", async () => {
  const client = new SessionRefineClient(async () =>
    response({ should_refine: true, selected_turn_ids: ["overlap-turn"] }),
  );
  await assert.rejects(
    client.gate(
      createModelConfiguration("https://model.example/v1", "knowledge-model"),
      "secret",
      {
        turns: [
          {
            turn_id: "overlap-turn",
            user_prompt: "旧上下文",
            final_answer: "旧回答",
          },
          {
            turn_id: "new-turn",
            user_prompt: "新上下文",
            final_answer: "新回答",
          },
        ],
        eligible_turn_ids: ["new-turn"],
        active_memories: [],
      },
    ),
  );
});

test("Refiner allows atomic edits from one turn but rejects long cards and duplicate targets", async () => {
  const configuration = createModelConfiguration(
    "https://model.example/v1",
    "knowledge-model",
  );
  const input = {
    turns: [
      {
        turn_id: "turn-atomic",
        user_prompt: "这轮明确了两个独立规则。",
        final_answer: "两个规则均已验证。",
      },
    ],
    eligible_turn_ids: ["turn-atomic"],
    selected_turn_ids: ["turn-atomic"],
    active_memories: [{ id: "memory-1", version: 1, ...CARD }],
  };
  const atomic = new SessionRefineClient(async () =>
    response({
      edits: [
        {
          action: "create",
          source_turn_id: "turn-atomic",
          target_memory_id: null,
          base_version: null,
          memory: { ...CARD, title: "原子规则一" },
        },
        {
          action: "create",
          source_turn_id: "turn-atomic",
          target_memory_id: null,
          base_version: null,
          memory: { ...CARD, title: "原子规则二" },
        },
      ],
    }),
  );
  assert.equal(
    (await atomic.refine(configuration, "secret", input)).result.edits.length,
    2,
  );

  const tooLong = new SessionRefineClient(async () =>
    response({
      edits: [
        {
          action: "create",
          source_turn_id: "turn-atomic",
          target_memory_id: null,
          base_version: null,
          memory: { ...CARD, knowledge: "长".repeat(121) },
        },
      ],
    }),
  );
  await assert.rejects(tooLong.refine(configuration, "secret", input));

  const duplicateTarget = new SessionRefineClient(async () =>
    response({
      edits: [1, 2].map((index) => ({
        action: "update",
        source_turn_id: "turn-atomic",
        target_memory_id: "memory-1",
        base_version: 1,
        memory: { ...CARD, title: `重复更新 ${index}` },
      })),
    }),
  );
  await assert.rejects(duplicateTarget.refine(configuration, "secret", input));
});
