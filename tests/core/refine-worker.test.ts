import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { RefineWorker } from "../../src/jobs/refine-worker.js";
import { StrictModelClient } from "../../src/model/client.js";
import { createModelConfiguration } from "../../src/model/configuration.js";
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

function sessionClient(
  database: MemoryDatabase,
  gate: unknown,
  refiner: unknown,
): SessionRefineClient {
  return new SessionRefineClient(database.modelSettings, async (_url, init) => {
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
    "extract-model",
  );
  database.modelSettings.saveConfiguration(configuration);
  database.modelSettings.markStrictSchemaVerified(
    "https://model.example",
    "extract-model",
  );
  database.modelSettings.setConsent("https://model.example", true, true);
  database.modelSettings.enableExtraction("https://model.example", "extract-model");
}

test("P0-03/P0-14 worker projects allowed fields, extracts without a correction lexicon, and persists only the card", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-worker-"));
  const project = join(root, "project");
  const data = join(root, "data");
  await mkdir(project, { recursive: true });
  const databasePath = join(data, "memory.sqlite");
  const database = new MemoryDatabase(databasePath);
  enableExtraction(database);
  const session = database.bindSession(
    "codex",
    "session-user-1",
    await resolveRepoIdentity(project),
  );
  const queued = database.enqueueStop(
    session.id,
    "turn-target",
    FIXTURE.pathname,
    true,
  );
  assert.ok(queued.jobId);
  let requestBody = "";
  const client = new StrictModelClient(database.modelSettings, async (_url, init) => {
    requestBody = String(init?.body);
    return response({
      action: "create",
      target_memory_id: null,
      base_version: null,
      memory: {
        title: "请求超时",
        wrong_behavior: "沿用默认 timeout",
        correct_behavior: "后续同类请求使用 30s timeout。",
        applicability: "网络请求",
      },
    });
  });
  const worker = new RefineWorker(
    database,
    new MemoryKeyProvider("test-key"),
    client,
    sessionClient(
      database,
      { should_refine: true, candidate_turn_ids: ["turn-target"] },
      {
        edits: [
          {
            action: "create",
            source_turn_id: "turn-target",
            target_memory_id: null,
            base_version: null,
            memory: {
              title: "请求超时",
              wrong_behavior: "沿用默认 timeout",
              correct_behavior: "后续同类请求使用 30s timeout。",
              applicability: "网络请求",
            },
          },
        ],
      },
    ),
    1,
  );
  worker.wake();
  await worker.idle();

  assert.match(database.recall(session.repoId, "网络请求 timeout"), /30s/u);
  assert.match(requestBody, /下次 timeout 用 30s/u);
  assert.match(requestBody, /以后会把 timeout 设为 30s/u);
  assert.match(requestBody, /把重试次数改成两次/u);
  assert.doesNotMatch(requestBody, /不得读取或投影/u);
  assert.doesNotMatch(requestBody, /last_agent_message/u);
  database.close();

  const persisted = Buffer.concat(
    await Promise.all((await readdir(data)).map((name) => readFile(join(data, name)))),
  ).toString("utf8");
  assert.doesNotMatch(persisted, /下次 timeout 用 30s/u);
  assert.doesNotMatch(persisted, /以后会把 timeout 设为 30s/u);
});

test("P0-24 turn candidates remain invisible until the 25-turn or compact checkpoint", async () => {
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
    const queued = database.enqueueStop(
      session.id,
      "checkpoint-turn",
      FIXTURE.pathname,
      true,
    );
    assert.ok(queued.jobId);
    database.sessionRefines.stage(
      queued.jobId,
      session.repoId,
      session.id,
      "checkpoint-turn",
      {
        action: "create",
        target_memory_id: null,
        base_version: null,
        memory: {
          title: "候选规则",
          wrong_behavior: "立即写入",
          correct_behavior: "检查点后才写入长期记忆。",
          applicability: "本仓库",
        },
      },
      1,
    );
    assert.equal(database.recall(session.repoId, "候选规则"), "");
    assert.equal(database.listPendingReviews().length, 0);
    assert.equal(database.sessionRefines.stagedCount(session.id), 1);
    assert.equal(
      database.sessionRefines.enqueue(session.id, session.repoId, "turn_interval"),
      null,
    );
    assert.ok(database.sessionRefines.enqueue(session.id, session.repoId, "compact"));
  } finally {
    database.close();
  }
});

test("failed strict Schema connection test cannot enable auto_extract", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-manager-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const keyProvider = new MemoryKeyProvider();
  const client = new StrictModelClient(database.modelSettings, async () =>
    response({ message: "ordinary JSON only" }, 400),
  );
  const manager = new ModelManager(
    database,
    keyProvider,
    client,
    sessionClient(
      database,
      { should_refine: false, candidate_turn_ids: [] },
      { edits: [] },
    ),
  );
  try {
    await manager.configure(
      "https://model.example/v1",
      "ordinary-json-model",
      "test-key",
    );
    await assert.rejects(manager.testConnection());
    assert.equal(database.extractionEnabled(), false);
    assert.throws(() => manager.enable());
    assert.equal(database.extractionEnabled(), false);
  } finally {
    database.close();
  }
});

test("model reconfiguration can reuse an existing Keychain secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-manager-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const keyProvider = new MemoryKeyProvider("stored-key");
  const manager = new ModelManager(database, keyProvider);
  try {
    await manager.configure("https://model.example/v1", "stored-key-model", null);
    assert.equal(await keyProvider.get(), "stored-key");
    assert.equal(database.modelSettings.getConfiguration()?.model, "stored-key-model");
  } finally {
    database.close();
  }
});

test("single auto-extract control bundles required consent and can turn it off", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-manager-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const keyProvider = new MemoryKeyProvider();
  const client = new StrictModelClient(database.modelSettings, async () =>
    response({
      action: "skip",
      target_memory_id: null,
      base_version: null,
      memory: null,
    }),
  );
  const manager = new ModelManager(
    database,
    keyProvider,
    client,
    sessionClient(
      database,
      { should_refine: false, candidate_turn_ids: [] },
      { edits: [] },
    ),
  );
  try {
    await manager.configure("https://model.example/v1", "strict-model", "test-key");
    await manager.testConnection();
    manager.enable();
    assert.equal(database.extractionEnabled(), true);
    assert.equal(database.getSetting("prompt_consent"), "true");
    assert.equal(database.getSetting("final_answer_consent"), "true");

    manager.pause();
    assert.equal(database.extractionEnabled(), false);
    assert.equal(database.getSetting("prompt_consent"), "false");
    assert.equal(database.getSetting("final_answer_consent"), "false");
  } finally {
    database.close();
  }
});
