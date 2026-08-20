import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { replaceMemoryFts } from "../../src/db/fts-writer.js";
import { topicKey } from "../../src/db/helpers.js";
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

test("P0-14 one source turn can atomically create multiple knowledge cards", async () => {
  const { db, a1 } = await setup();
  try {
    const captured = captureTurn(db, a1, "turn-two-rules");
    assert.ok(captured.jobId);
    const edits = [
      {
        action: "create" as const,
        source_turn_id: "turn-two-rules",
        target_memory_id: null,
        base_version: null,
        memory: {
          kind: "invariant" as const,
          title: "超时起点只写一次",
          knowledge: "首次写入超时起点后，重复消息不得重置它。",
          rationale: "重置起点会让重复消息无限延后超时。",
          applicability: "聚合状态机",
        },
      },
      {
        action: "create" as const,
        source_turn_id: "turn-two-rules",
        target_memory_id: null,
        base_version: null,
        memory: {
          kind: "decision" as const,
          title: "超时由 Mongo deadline 扫描",
          knowledge: "V1 使用 Mongo 持久化 deadline 扫描，不使用阻塞线程等待。",
          rationale: "持久化截止时间支持进程重启和多实例竞争。",
          applicability: "聚合超时",
        },
      },
    ];
    const sources = [{ job_id: captured.jobId, turn_id: "turn-two-rules" }];
    const first = db.applySessionRefinement(a1.repoId, a1.id, edits, sources);
    assert.equal(first.length, 2);
    assert.equal(db.listMemories(a1.repoId).length, 2);
    assert.equal(db.listPendingReviews().length, 2);

    const duplicate = db.applySessionRefinement(a1.repoId, a1.id, edits, sources);
    assert.deepEqual(
      duplicate.map((candidate) => candidate.candidateId),
      first.map((candidate) => candidate.candidateId),
    );
    assert.equal(db.listMemories(a1.repoId).length, 2);
    assert.ok(first[0]?.memoryId);
    db.hardDeleteMemory(first[0].memoryId);
    assert.equal(db.listMemories(a1.repoId).length, 1);
    assert.equal(db.listPendingReviews().length, 1);
  } finally {
    db.close();
  }
});

test("legacy long cards remain readable but recall injects at most 120 characters", async () => {
  const { db, a1 } = await setup();
  try {
    const memoryId = randomUUID();
    const versionId = randomUUID();
    const timestamp = new Date().toISOString();
    const card: MemoryCard = {
      kind: "lesson",
      title: "遗留长知识",
      knowledge: `遗留召回规则${"长".repeat(130)}`,
      rationale: "该卡模拟升级前已经落盘的 knowledge≤240 历史数据。",
      applicability: "兼容迁移",
    };
    db.core.transaction(() => {
      db.core.db
        .prepare(
          `INSERT INTO memories(
            id,repo_id,active_version_id,topic_key,state,created_at,updated_at
          ) VALUES (?,?,NULL,?,'active',?,?)`,
        )
        .run(memoryId, a1.repoId, topicKey(card.title), timestamp, timestamp);
      db.core.db
        .prepare(
          `INSERT INTO memory_versions(id,memory_id,version_no,content,created_at)
           VALUES (?,?,1,?,?)`,
        )
        .run(versionId, memoryId, JSON.stringify(card), timestamp);
      db.core.db
        .prepare("UPDATE memories SET active_version_id=? WHERE id=?")
        .run(versionId, memoryId);
      replaceMemoryFts(db.core, memoryId, a1.repoId, card);
    });
    assert.equal(
      Array.from(db.listMemories(a1.repoId)[0]?.card.knowledge ?? "").length,
      136,
    );
    const recall = db.recall(a1.repoId, "遗留召回规则");
    assert.match(recall, /遗留召回规则/u);
    assert.match(recall, /…/u);
    assert.doesNotMatch(recall, /长{130}/u);
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
