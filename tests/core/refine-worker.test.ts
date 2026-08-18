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
  const worker = new RefineWorker(database, new MemoryKeyProvider("test-key"), client);
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

test("failed strict Schema connection test cannot enable auto_extract", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-manager-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const keyProvider = new MemoryKeyProvider();
  const client = new StrictModelClient(database.modelSettings, async () =>
    response({ message: "ordinary JSON only" }, 400),
  );
  const manager = new ModelManager(database, keyProvider, client);
  try {
    await manager.configure(
      "https://model.example/v1",
      "ordinary-json-model",
      "test-key",
    );
    await assert.rejects(manager.testConnection());
    assert.equal(database.extractionEnabled(), false);
    assert.throws(() => manager.enable(true, true));
    assert.equal(database.extractionEnabled(), false);
  } finally {
    database.close();
  }
});
