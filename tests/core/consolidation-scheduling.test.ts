import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeConsolidationStore } from "../../src/db/consolidation-store.js";
import { MemoryDatabase } from "../../src/db/database.js";
import { resolveRepoIdentity } from "../../src/repo/identity.js";
import { applyCreate } from "../helpers/apply-memory.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "clm-consolidation-schedule-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const session = database.bindSession(
    "codex",
    "consolidation-schedule-session",
    await resolveRepoIdentity(project),
  );
  applyCreate(database, session, "seed", {
    kind: "lesson",
    title: "单卡也要检查",
    knowledge: "单张过载知识卡也可能需要拆分。",
    rationale: "split 检查不能要求仓库至少已有两张卡。",
    applicability: "定时知识整合",
  });
  return { database, session };
}

test("daily scheduling includes a one-card repository and persists 24 hours", async () => {
  const { database, session } = await setup();
  let current = new Date("2026-08-19T00:00:00.000Z");
  const store = new KnowledgeConsolidationStore(database.core, () => current);
  try {
    assert.equal(store.enqueueDue(), 1);
    const first = store.claimNext();
    assert.ok(first);
    store.complete(first.jobId, []);
    assert.equal(
      database.getSetting(`last_consolidation_revision:${session.repoId}`),
      "tacit-atomic-split/v1",
    );
    current = new Date("2026-08-19T23:00:00.000Z");
    assert.equal(store.enqueueDue(), 0);
    current = new Date("2026-08-20T01:00:00.000Z");
    assert.equal(store.enqueueDue(), 1);
    assert.equal(store.claimNext()?.repoId, session.repoId);
  } finally {
    database.close();
  }
});

test("a new consolidation Schema revision ignores the old daily timestamp", async () => {
  const { database, session } = await setup();
  const current = new Date("2026-08-20T00:00:00.000Z");
  const store = new KnowledgeConsolidationStore(database.core, () => current);
  try {
    database.setSetting(
      `last_consolidation_at:${session.repoId}`,
      current.toISOString(),
    );
    database.setSetting(`last_consolidation_revision:${session.repoId}`, "old");
    assert.equal(store.enqueueDue(), 1);
  } finally {
    database.close();
  }
});

test("successful schema recheck clears resolved job metadata but keeps audit", async () => {
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
