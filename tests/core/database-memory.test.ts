import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { resolveRepoIdentity } from "../../src/repo/identity.js";
import type { MemoryCard } from "../../src/types.js";
import { applyCreate, applyUpdate, captureTurn } from "../helpers/apply-memory.js";

const FIRST_CARD: MemoryCard = {
  kind: "lesson",
  title: "请求超时",
  knowledge: "同类请求把 timeout 设置为 30s。",
  rationale: "项目中的默认超时不足以覆盖该类请求。",
  applicability: "网络请求",
};

const SECOND_CARD: MemoryCard = {
  kind: "lesson",
  title: "请求超时",
  knowledge: "同类请求把 timeout 设置为 60s。",
  rationale: "后续验证表明 30s 对该类请求仍然不足。",
  applicability: "网络请求",
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "clm-db-"));
  const repoA = join(root, "a", "demo");
  const repoB = join(root, "b", "demo");
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });
  const databasePath = join(root, "data", "memory.sqlite");
  const db = new MemoryDatabase(databasePath);
  const a1 = db.bindSession("codex", "session-a1", await resolveRepoIdentity(repoA));
  const a2 = db.bindSession("codex", "session-a2", await resolveRepoIdentity(repoA));
  const b1 = db.bindSession("codex", "session-b1", await resolveRepoIdentity(repoB));
  return { root, databasePath, db, a1, a2, b1 };
}

test("P0-01/P0-16 multiple sessions share one repo while same-name folders stay isolated", async () => {
  const { db, a1, a2, b1 } = await setup();
  try {
    assert.equal(a1.repoId, a2.repoId);
    assert.notEqual(a1.repoId, b1.repoId);
    applyCreate(db, a1, "turn-create", FIRST_CARD);
    assert.match(db.recall(a2.repoId, "网络请求 timeout"), /30s/u);
    assert.equal(db.recall(b1.repoId, "网络请求 timeout"), "");
  } finally {
    db.close();
  }
});

test("final refined creates are active immediately and enter pending review", async () => {
  const { db, a1 } = await setup();
  try {
    applyCreate(db, a1, "turn-create-review", FIRST_CARD);
    assert.match(db.recall(a1.repoId, "网络请求 timeout"), /30s/u);
    const [review] = db.listPendingReviews();
    assert.ok(review);
    assert.equal(review.action, "create");
    assert.equal(review.oldCard, null);
    assert.equal(review.newVersion, 1);
    db.confirmCandidate(review.candidateId);
    assert.equal(db.listPendingReviews().length, 0);
  } finally {
    db.close();
  }
});

test("P0-12/P0-13 update is active immediately and rollback creates a new version", async () => {
  const { db, a1 } = await setup();
  try {
    const created = applyCreate(db, a1, "turn-create", FIRST_CARD);
    assert.ok(created.memoryId);
    applyUpdate(db, a1, "turn-update", created.memoryId, 1, SECOND_CARD);
    const recalled = db.recall(a1.repoId, "请求 timeout 网络");
    assert.match(recalled, /60s/u);
    assert.doesNotMatch(recalled, /30s/u);
    const versions = db.listVersions(created.memoryId);
    const original = versions.find((value) => value.version === 1);
    assert.ok(original);
    assert.equal(db.rollbackMemory(created.memoryId, original.id), 3);
    assert.match(db.recall(a1.repoId, "请求 timeout 网络"), /30s/u);
    assert.equal(db.listVersions(created.memoryId).length, 3);
  } finally {
    db.close();
  }
});

test("P0-23 stale model result never overwrites a newer active version", async () => {
  const { db, a1 } = await setup();
  try {
    const created = applyCreate(db, a1, "turn-create", FIRST_CARD);
    assert.ok(created.memoryId);
    applyUpdate(db, a1, "turn-fresh", created.memoryId, 1, SECOND_CARD);
    assert.throws(() =>
      applyUpdate(db, a1, "turn-late", created.memoryId, 1, FIRST_CARD),
    );
    assert.equal(db.healthSummary().stale_candidates, 1);
    assert.match(db.recall(a1.repoId, "请求 timeout 网络"), /60s/u);
  } finally {
    db.close();
  }
});

test("P0-07 duplicate Stop is idempotent and prompt text is not persisted", async () => {
  const { db, a1, databasePath } = await setup();
  const secretPrompt = "PROMPT-CANARY-DO-NOT-PERSIST timeout";
  try {
    const first = captureTurn(db, a1, "turn-once");
    const duplicate = captureTurn(db, a1, "turn-once");
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.turnId, duplicate.turnId);
    assert.equal(first.jobId, duplicate.jobId);
    assert.equal(db.recall(a1.repoId, secretPrompt), "");
  } finally {
    db.close();
  }
  const bytes = await readFile(databasePath);
  assert.equal(bytes.includes(Buffer.from(secretPrompt)), false);
});

test("P0-05 hard delete purges backups and a late refine result cannot revive memory", async () => {
  const { db, a1, root } = await setup();
  try {
    const created = applyCreate(db, a1, "turn-create", FIRST_CARD);
    assert.ok(created.memoryId);
    const late = captureTurn(db, a1, "turn-late-after-delete");
    const backup = db.createBackup();
    assert.equal((await readFile(backup)).includes(Buffer.from("请求超时")), true);

    db.hardDeleteMemory(created.memoryId);
    assert.deepEqual(await readdir(join(root, "data", "backups")), []);
    assert.ok(late.jobId);
    assert.throws(() =>
      db.applySessionRefinement(
        a1.repoId,
        a1.id,
        [
          {
            action: "update",
            source_turn_id: "turn-late-after-delete",
            target_memory_id: created.memoryId,
            base_version: 1,
            memory: SECOND_CARD,
          },
        ],
        [{ job_id: late.jobId, turn_id: "turn-late-after-delete" }],
      ),
    );
    assert.equal(db.recall(a1.repoId, "请求 timeout 网络"), "");
    assert.equal(db.listVersions(created.memoryId).length, 0);
  } finally {
    db.close();
  }
});

test("repository menu pauses collection and clears managed memory data", async () => {
  const { db, a1, root } = await setup();
  try {
    applyCreate(db, a1, "turn-repository-menu", FIRST_CARD);
    db.createBackup();
    db.setRepositoryPaused(a1.repoId, true);
    assert.equal(db.repositoryPaused(a1.repoId), true);
    assert.equal(
      db.listRepositories().find((repo) => repo.id === a1.repoId)?.paused,
      true,
    );
    db.clearRepositoryMemories(a1.repoId);
    assert.deepEqual(db.listMemories(a1.repoId), []);
    assert.deepEqual(await readdir(join(root, "data", "backups")), []);
  } finally {
    db.close();
  }
});
