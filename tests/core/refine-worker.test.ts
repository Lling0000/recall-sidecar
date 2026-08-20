import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { RefineWorker } from "../../src/jobs/refine-worker.js";
import { createModelConfiguration } from "../../src/model/configuration.js";
import { KnowledgeConsolidationClient } from "../../src/model/consolidation-client.js";
import { ModelManager } from "../../src/model/manager.js";
import { SessionRefineClient } from "../../src/model/session-client.js";
import { resolveRepoIdentity } from "../../src/repo/identity.js";
import { MemoryKeyProvider } from "../helpers/memory-key.js";

const FIXTURE = new URL("../fixtures/rollout-0.148.0-alpha.9.jsonl", import.meta.url);

function response(value: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
    { status },
  );
}

function sessionClient(gate: unknown, refiner: unknown): SessionRefineClient {
  return new SessionRefineClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      response_format: { json_schema: { name: string } };
    };
    return response(
      body.response_format.json_schema.name.endsWith("_gate") ? gate : refiner,
    );
  });
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

test("P0-03/P0-14 checkpoint Gate and Refiner persist only project knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-worker-"));
  const project = join(root, "project");
  const data = join(root, "data");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(data, "memory.sqlite"));
  enableExtraction(database);
  const session = database.bindSession(
    "codex",
    "session-user-1",
    await resolveRepoIdentity(project),
    FIXTURE.pathname,
  );
  for (const turn of ["turn-previous", "turn-target"]) {
    database.captureStop(session.id, session.repoId, turn, FIXTURE.pathname, true);
  }
  assert.ok(database.sessionRefines.enqueue(session.id, session.repoId, "compact"));
  const client = sessionClient(
    { should_refine: true, selected_turn_ids: ["turn-target"] },
    {
      edits: [
        {
          action: "create",
          source_turn_id: "turn-target",
          target_memory_id: null,
          base_version: null,
          memory: {
            kind: "lesson",
            title: "请求超时经验",
            knowledge: "本仓库同类请求使用 30s timeout。",
            rationale: "本次项目工作明确纠正了原超时设置。",
            applicability: "网络请求",
          },
        },
      ],
    },
  );
  const worker = new RefineWorker(database, new MemoryKeyProvider("test-key"), client);
  worker.wake();
  await worker.idle();

  assert.match(database.recall(session.repoId, "网络请求 timeout"), /30s/u);
  assert.equal(database.sessionRefines.pendingCount(session.id), 0);
  database.close();

  const persisted = Buffer.concat(
    await Promise.all((await readdir(data)).map((name) => readFile(join(data, name)))),
  ).toString("utf8");
  assert.doesNotMatch(persisted, /下次 timeout 用 30s/u);
  assert.doesNotMatch(persisted, /以后会把 timeout 设为 30s/u);
});

test("P0-24 turn references remain invisible before 25 turns or compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-checkpoint-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  try {
    const session = database.bindSession(
      "codex",
      "checkpoint-session",
      await resolveRepoIdentity(project),
      FIXTURE.pathname,
    );
    database.captureStop(
      session.id,
      session.repoId,
      "turn-target",
      FIXTURE.pathname,
      true,
    );
    assert.equal(database.recall(session.repoId, "timeout"), "");
    assert.equal(database.sessionRefines.pendingCount(session.id), 1);
    assert.equal(
      database.sessionRefines.enqueue(session.id, session.repoId, "turn_interval"),
      null,
    );
    assert.ok(database.sessionRefines.enqueue(session.id, session.repoId, "compact"));
  } finally {
    database.close();
  }
});

test("checkpoint uses 25 new turns plus 5 processed context-only overlap turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-overlap-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  try {
    const session = database.bindSession(
      "codex",
      "overlap-session",
      await resolveRepoIdentity(project),
      FIXTURE.pathname,
    );
    for (let index = 1; index <= 5; index += 1) {
      database.captureStop(
        session.id,
        session.repoId,
        `old-${index}`,
        FIXTURE.pathname,
        true,
      );
    }
    const firstId = database.sessionRefines.enqueue(
      session.id,
      session.repoId,
      "compact",
    );
    assert.ok(firstId);
    const firstJob = database.sessionRefines.claimNext();
    assert.ok(firstJob);
    const firstBatch = database.sessionRefines.batch(firstJob);
    database.sessionRefines.finish(
      firstJob.jobId,
      new Set(firstBatch.turns.map((turn) => turn.internal_turn_id)),
      false,
    );

    for (let index = 1; index <= 25; index += 1) {
      database.captureStop(
        session.id,
        session.repoId,
        `new-${index}`,
        FIXTURE.pathname,
        true,
      );
    }
    assert.ok(
      database.sessionRefines.enqueue(session.id, session.repoId, "turn_interval"),
    );
    const secondJob = database.sessionRefines.claimNext();
    assert.ok(secondJob);
    const secondBatch = database.sessionRefines.batch(secondJob);
    assert.equal(secondBatch.turns.filter((turn) => turn.role === "overlap").length, 5);
    assert.equal(
      secondBatch.turns.filter((turn) => turn.role === "eligible").length,
      25,
    );
    assert.deepEqual(
      secondBatch.turns.slice(0, 5).map((turn) => turn.turn_id),
      ["old-1", "old-2", "old-3", "old-4", "old-5"],
    );
  } finally {
    database.close();
  }
});

test("health only counts unresolved failed checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-failed-health-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  try {
    const session = database.bindSession(
      "codex",
      "failed-health-session",
      await resolveRepoIdentity(project),
      FIXTURE.pathname,
    );
    database.captureStop(
      session.id,
      session.repoId,
      "failed-health-turn",
      FIXTURE.pathname,
      true,
    );
    assert.ok(database.sessionRefines.enqueue(session.id, session.repoId, "compact"));
    const failed = database.sessionRefines.claimNext();
    assert.ok(failed);
    database.sessionRefines.fail(failed.jobId, "model_invalid_structured_output");
    assert.equal(database.healthSummary().failed_session_refines, 1);

    assert.ok(database.sessionRefines.enqueue(session.id, session.repoId, "compact"));
    const retry = database.sessionRefines.claimNext();
    assert.ok(retry);
    const batch = database.sessionRefines.batch(retry);
    database.sessionRefines.finish(
      retry.jobId,
      new Set(batch.turns.map((turn) => turn.internal_turn_id)),
      false,
    );
    assert.equal(database.healthSummary().failed_session_refines, 0);
  } finally {
    database.close();
  }
});

test("failed Gate strict Schema test cannot enable auto_extract", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-manager-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const keyProvider = new MemoryKeyProvider();
  const manager = new ModelManager(
    database,
    keyProvider,
    new SessionRefineClient(async () => response({ message: "ordinary JSON" }, 400)),
  );
  try {
    await manager.configure("https://model.example/v1", "ordinary-json", "key");
    await assert.rejects(manager.testConnection());
    assert.equal(database.extractionEnabled(), false);
    assert.equal(database.getSetting("model_last_error"), "gate_model_http_400");
    assert.throws(() => manager.enable());
  } finally {
    database.close();
  }
});

test("model configuration reuses Keychain and clears legacy usage settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-manager-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const keyProvider = new MemoryKeyProvider("stored-key");
  const manager = new ModelManager(database, keyProvider);
  try {
    database.setSetting("model_usage_date", "2026-08-19");
    database.setSetting("model_usage_count", "100");
    await manager.configure("https://model.example/v1", "stored-model", null);
    assert.equal(await keyProvider.get(), "stored-key");
    assert.equal(database.modelSettings.getConfiguration()?.model, "stored-model");
    assert.equal(database.getSetting("model_usage_date"), null);
    assert.equal(database.getSetting("model_usage_count"), null);
  } finally {
    database.close();
  }
});

test("single automatic knowledge switch bundles consent and can turn it off", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-manager-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const keyProvider = new MemoryKeyProvider();
  const manager = new ModelManager(
    database,
    keyProvider,
    sessionClient({ should_refine: false, selected_turn_ids: [] }, { edits: [] }),
    new KnowledgeConsolidationClient(async () => response({ suggestions: [] })),
  );
  try {
    await manager.configure("https://model.example/v1", "strict-model", "test-key");
    await manager.testConnection();
    manager.enable();
    assert.equal(database.extractionEnabled(), true);
    manager.pause();
    assert.equal(database.extractionEnabled(), false);
  } finally {
    database.close();
  }
});
