import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { resolveRepoIdentity } from "../../src/repo/identity.js";
import { applyCreate } from "../helpers/apply-memory.js";

test("legacy candidate and consolidation tables migrate without losing memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-migration-"));
  const project = join(root, "project");
  const path = join(root, "memory.sqlite");
  await mkdir(project, { recursive: true });
  const initial = new MemoryDatabase(path);
  const session = initial.bindSession(
    "codex",
    "migration-session",
    await resolveRepoIdentity(project),
  );
  applyCreate(initial, session, "migration-turn", {
    kind: "lesson",
    title: "迁移保留知识",
    knowledge: "候选表迁移不能删除已有知识版本。",
    rationale: "升级只改变候选幂等键和整合建议类型。",
    applicability: "数据库升级",
  });
  initial.close();

  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys=OFF");
  raw.exec("ALTER TABLE candidates RENAME TO candidates_current");
  raw.exec(`CREATE TABLE candidates (
    id TEXT PRIMARY KEY,
    refine_job_id TEXT NOT NULL UNIQUE REFERENCES refine_jobs(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repositories(id), action TEXT NOT NULL,
    target_id TEXT, applied_memory_id TEXT, base_version INTEGER,
    revision INTEGER NOT NULL, content TEXT,
    state TEXT NOT NULL CHECK (state IN ('applied','stale')),
    review_state TEXT NOT NULL CHECK (review_state IN ('none','unverified','confirmed','rolled_back')),
    created_at TEXT NOT NULL
  )`);
  raw.exec(`INSERT INTO candidates(
    id,refine_job_id,repo_id,action,target_id,applied_memory_id,base_version,
    revision,content,state,review_state,created_at
  ) SELECT id,refine_job_id,repo_id,action,target_id,applied_memory_id,
    base_version,revision,content,state,review_state,created_at FROM candidates_current`);
  raw.exec("DROP TABLE candidates_current");
  raw.exec("DROP TABLE knowledge_consolidation_suggestions");
  raw.exec(`CREATE TABLE knowledge_consolidation_suggestions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES knowledge_consolidation_jobs(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repositories(id),
    kind TEXT NOT NULL CHECK (kind IN ('merge','conflict')),
    target_memory_id TEXT NOT NULL,target_base_version INTEGER NOT NULL,
    related_json TEXT NOT NULL,proposed_content TEXT,reason TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending','applied','ignored','stale')),
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  )`);
  raw.close();

  const migrated = new MemoryDatabase(path);
  try {
    const candidateColumns = migrated.core.db
      .prepare("PRAGMA table_info(candidates)")
      .all() as Array<{ name: string }>;
    assert.ok(candidateColumns.some((column) => column.name === "edit_ordinal"));
    const candidate = migrated.core.db
      .prepare("SELECT edit_ordinal FROM candidates")
      .get() as { edit_ordinal: number };
    assert.equal(candidate.edit_ordinal, 0);
    const suggestionSql = migrated.core.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_consolidation_suggestions'",
      )
      .get() as { sql: string };
    assert.match(suggestionSql.sql, /'split'/u);
    assert.equal(migrated.listMemories(session.repoId).length, 1);
  } finally {
    migrated.close();
  }
});
