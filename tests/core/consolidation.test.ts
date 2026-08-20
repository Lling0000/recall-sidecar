import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeConsolidationStore } from "../../src/db/consolidation-store.js";
import { MemoryDatabase } from "../../src/db/database.js";
import { KnowledgeConsolidationWorker } from "../../src/jobs/consolidation-worker.js";
import { createModelConfiguration } from "../../src/model/configuration.js";
import { KnowledgeConsolidationClient } from "../../src/model/consolidation-client.js";
import { resolveRepoIdentity } from "../../src/repo/identity.js";
import type { MemoryCard } from "../../src/types.js";
import { applyCreate } from "../helpers/apply-memory.js";
import { MemoryKeyProvider } from "../helpers/memory-key.js";

const CARD_A: MemoryCard = {
  kind: "pitfall",
  title: "生成文件会被覆盖",
  knowledge: "直接修改生成文件会在下次生成时被覆盖。",
  rationale: "项目中已观察到生成器覆盖手工修改。",
  applicability: "本仓库生成代码",
};

const CARD_B: MemoryCard = {
  kind: "pitfall",
  title: "应修改生成源",
  knowledge: "需要变更生成代码时，应修改生成源而不是产物。",
  rationale: "修改生成源后重新生成才能稳定保留变更。",
  applicability: "本仓库生成代码",
};

const MERGED_CARD: MemoryCard = {
  kind: "pitfall",
  title: "生成代码必须修改生成源",
  knowledge: "直接修改生成产物会被覆盖；应修改生成源后重新生成。",
  rationale: "项目中已观察到产物覆盖，修改生成源可以稳定保留变更。",
  applicability: "本仓库生成代码",
};

function response(value: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }),
    { status: 200 },
  );
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "clm-consolidation-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const session = database.bindSession(
    "codex",
    "consolidation-session",
    await resolveRepoIdentity(project),
  );
  for (const [index, card] of [CARD_A, CARD_B].entries()) {
    const turn = `seed-${index}`;
    applyCreate(database, session, turn, card);
  }
  enableExtraction(database);
  return { database, session };
}

function enableExtraction(database: MemoryDatabase): void {
  const configuration = createModelConfiguration(
    "https://model.example/v1",
    "knowledge-model",
  );
  database.modelSettings.saveConfiguration(configuration);
  database.modelSettings.markStrictSchemaVerified(
    "https://model.example",
    "knowledge-model",
  );
  database.modelSettings.setConsent("https://model.example", true, true);
  database.modelSettings.enableExtraction("https://model.example", "knowledge-model");
}

function suggestion(database: MemoryDatabase, kind: "merge" | "conflict" = "merge") {
  const active = database.listMemories().filter((memory) => memory.state === "active");
  assert.equal(active.length, 2);
  return {
    kind,
    target_memory_id: active[0]?.id,
    target_base_version: active[0]?.activeVersion,
    related_memories: [
      {
        memory_id: active[1]?.id,
        base_version: active[1]?.activeVersion,
      },
    ],
    proposed_memory: kind === "merge" ? MERGED_CARD : null,
    reason:
      kind === "merge"
        ? "两张卡描述同一生成代码坑点，适用范围相同且内容互补。"
        : "两张卡在相同范围内给出无法同时成立的结论。",
  };
}

test("consolidation uses strict Schema and rejects scope-expanding merges", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const active = [
    { id: "a", version: 1, ...CARD_A },
    { id: "b", version: 1, ...CARD_B },
  ];
  const client = new KnowledgeConsolidationClient(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response({
      suggestions: [
        {
          kind: "merge",
          target_memory_id: "a",
          target_base_version: 1,
          related_memories: [{ memory_id: "b", base_version: 1 }],
          proposed_memory: MERGED_CARD,
          reason: "同主题、同范围且互补。",
        },
      ],
    });
  });
  const result = await client.consolidate(
    createModelConfiguration("https://model.example/v1", "knowledge-model"),
    "secret",
    { active_memories: active },
  );
  assert.equal(result.result.suggestions.length, 1);
  const format = requests[0]?.response_format as {
    json_schema: { name: string; strict: boolean };
  };
  assert.equal(format.json_schema.name, "codex_local_memory_consolidation");
  assert.equal(format.json_schema.strict, true);
  assert.doesNotMatch(JSON.stringify(requests), /user_prompt|final_answer/u);

  const invalid = new KnowledgeConsolidationClient(async () =>
    response({
      suggestions: [
        {
          kind: "merge",
          target_memory_id: "a",
          target_base_version: 1,
          related_memories: [{ memory_id: "b", base_version: 1 }],
          proposed_memory: { ...MERGED_CARD, applicability: "全部仓库" },
          reason: "错误地扩大范围。",
        },
      ],
    }),
  );
  await assert.rejects(
    invalid.consolidate(
      createModelConfiguration("https://model.example/v1", "knowledge-model"),
      "secret",
      { active_memories: active },
    ),
  );
});

test("P0-25 merge stays pending until confirmation then versions and archives", async () => {
  const { database, session } = await setup();
  try {
    const proposed = suggestion(database);
    const client = new KnowledgeConsolidationClient(async () =>
      response({ suggestions: [proposed] }),
    );
    const worker = new KnowledgeConsolidationWorker(
      database,
      new MemoryKeyProvider("test-key"),
      client,
    );
    assert.ok(database.consolidations.enqueue(session.repoId));
    worker.wake();
    await worker.idle();

    const before = database.listMemories(session.repoId);
    assert.equal(before.filter((memory) => memory.state === "active").length, 2);
    assert.equal(database.listPendingConsolidations().length, 1);

    assert.ok(database.consolidations.enqueue(session.repoId));
    worker.wake();
    await worker.idle();
    assert.equal(database.listPendingConsolidations().length, 1);

    const review = database.listPendingConsolidations()[0];
    assert.ok(review);
    assert.equal(database.applyConsolidationMerge(review.suggestionId), "applied");
    const after = database.listMemories(session.repoId);
    assert.equal(after.filter((memory) => memory.state === "active").length, 1);
    assert.equal(after.filter((memory) => memory.state === "archived").length, 1);
    const target = after.find((memory) => memory.id === review.target.memoryId);
    assert.equal(target?.activeVersion, 2);
    assert.equal(database.listVersions(review.target.memoryId).length, 2);
    assert.match(database.recall(session.repoId, "生成代码覆盖生成源"), /修改生成源/u);
  } finally {
    database.close();
  }
});

test("P0-25 conflicts never change active knowledge and can be ignored", async () => {
  const { database, session } = await setup();
  try {
    const client = new KnowledgeConsolidationClient(async () =>
      response({ suggestions: [suggestion(database, "conflict")] }),
    );
    const worker = new KnowledgeConsolidationWorker(
      database,
      new MemoryKeyProvider("test-key"),
      client,
    );
    assert.ok(database.consolidations.enqueue(session.repoId));
    worker.wake();
    await worker.idle();
    const review = database.listPendingConsolidations()[0];
    assert.equal(review?.kind, "conflict");
    assert.equal(
      database
        .listMemories(session.repoId)
        .filter((memory) => memory.state === "active").length,
      2,
    );
    assert.ok(review);
    assert.throws(() => database.applyConsolidationMerge(review.suggestionId));
    database.ignoreConsolidation(review.suggestionId);
    assert.equal(database.listPendingConsolidations().length, 0);
  } finally {
    database.close();
  }
});

test("daily scheduling persists its 24 hour boundary", async () => {
  const { database, session } = await setup();
  let current = new Date("2026-08-19T00:00:00.000Z");
  const store = new KnowledgeConsolidationStore(database.core, () => current);
  try {
    assert.equal(store.enqueueDue(), 1);
    const first = store.claimNext();
    assert.ok(first);
    store.complete(first.jobId, []);
    current = new Date("2026-08-19T23:00:00.000Z");
    assert.equal(store.enqueueDue(), 0);
    current = new Date("2026-08-20T01:00:00.000Z");
    assert.equal(store.enqueueDue(), 1);
    assert.equal(store.claimNext()?.repoId, session.repoId);
  } finally {
    database.close();
  }
});

test("successful schema recheck can clear resolved failed job metadata", async () => {
  const { database, session } = await setup();
  try {
    assert.ok(database.consolidations.enqueue(session.repoId));
    const job = database.consolidations.claimNext();
    assert.ok(job);
    database.consolidations.fail(job.jobId, "model_invalid_structured_output");
    assert.equal(database.consolidations.health().failed, 1);
    assert.equal(database.consolidations.clearResolvedFailures(), 1);
    assert.equal(database.consolidations.health().failed, 0);
    const audit = database.core.db
      .prepare(
        "SELECT count(*) AS count FROM audit_events WHERE action='knowledge_consolidation_failed'",
      )
      .get() as { count: number };
    assert.equal(Number(audit.count), 1);
  } finally {
    database.close();
  }
});
