import { randomUUID } from "node:crypto";
import type { DatabaseCore } from "./core.js";
import { replaceMemoryFts } from "./fts-writer.js";
import { now, parseCard, row, topicKey } from "./helpers.js";

export class MemoryAdminStore {
  constructor(private readonly core: DatabaseCore) {}

  confirmCandidate(candidateId: string): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(
          `UPDATE candidates SET review_state='confirmed'
           WHERE id=? AND state='applied'
             AND (review_state='unverified' OR (action='create' AND review_state='none'))`,
        )
        .run(candidateId);
      this.core.audit("candidate_confirmed", candidateId, {});
    });
  }

  rollback(memoryId: string, versionId: string): number {
    return this.core.transaction(() => {
      const target = this.rollbackTarget(memoryId, versionId);
      if (!target) throw new Error("rollback_target_not_found");
      const card = parseCard(target.content);
      const newVersion = target.active_version_no + 1;
      const newVersionId = randomUUID();
      const timestamp = now();
      this.core.db
        .prepare(
          `INSERT INTO memory_versions(
            id,memory_id,version_no,content,restores_version_id,created_at
          ) VALUES (?,?,?,?,?,?)`,
        )
        .run(newVersionId, memoryId, newVersion, target.content, versionId, timestamp);
      this.core.db
        .prepare(
          `UPDATE memories SET active_version_id=?,topic_key=?,state='active',updated_at=?
           WHERE id=?`,
        )
        .run(newVersionId, topicKey(card.title), timestamp, memoryId);
      replaceMemoryFts(this.core, memoryId, target.repo_id, card);
      this.core.db
        .prepare(
          "UPDATE candidates SET review_state='rolled_back' WHERE applied_memory_id=? AND review_state='unverified'",
        )
        .run(memoryId);
      this.core.bumpGeneration(target.repo_id);
      this.core.audit("memory_rolled_back", memoryId, {
        restored_version: target.version_no,
        new_version: newVersion,
      });
      return newVersion;
    });
  }

  archive(memoryId: string): void {
    this.core.transaction(() => {
      const memory = row<{ repo_id: string }>(
        this.core.db
          .prepare("SELECT repo_id FROM memories WHERE id=? AND state='active'")
          .get(memoryId),
      );
      if (!memory) throw new Error("memory_not_active");
      this.core.db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(memoryId);
      this.core.db
        .prepare("UPDATE memories SET state='archived',updated_at=? WHERE id=?")
        .run(now(), memoryId);
      this.core.bumpGeneration(memory.repo_id);
      this.core.audit("memory_archived", memoryId, { repo_id: memory.repo_id });
    });
  }

  hardDelete(memoryId: string): void {
    this.core.transaction(() => {
      const memory = row<{ repo_id: string }>(
        this.core.db.prepare("SELECT repo_id FROM memories WHERE id=?").get(memoryId),
      );
      if (!memory) {
        this.writeTombstone(memoryId);
        return;
      }
      this.writeTombstone(memoryId);
      this.core.db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(memoryId);
      this.purgeCandidateLinks(memoryId);
      this.core.db.prepare("DELETE FROM memories WHERE id=?").run(memoryId);
      this.core.bumpGeneration(memory.repo_id);
      this.core.audit("memory_hard_deleted", memoryId, {
        repo_id: memory.repo_id,
      });
    });
    this.core.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  clearRepository(repoId: string): void {
    this.core.transaction(() => {
      const memories = this.core.db
        .prepare("SELECT id FROM memories WHERE repo_id=?")
        .all(repoId) as unknown as Array<{ id: string }>;
      for (const memory of memories) {
        this.writeTombstone(memory.id);
        this.core.db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(memory.id);
        this.purgeCandidateLinks(memory.id);
      }
      this.core.db.prepare("DELETE FROM memories WHERE repo_id=?").run(repoId);
      this.core.bumpGeneration(repoId);
      this.core.audit("repository_memories_cleared", repoId, {
        count: memories.length,
      });
    });
    this.core.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  private rollbackTarget(memoryId: string, versionId: string): RollbackTarget | null {
    return row<RollbackTarget>(
      this.core.db
        .prepare(
          `SELECT m.repo_id,mv.content,mv.version_no,
            active.version_no AS active_version_no
           FROM memories m
           JOIN memory_versions mv ON mv.memory_id=m.id AND mv.id=?
           JOIN memory_versions active ON active.id=m.active_version_id
           LEFT JOIN deletion_tombstones d ON d.memory_id=m.id
           WHERE m.id=? AND m.state!='deleted' AND d.memory_id IS NULL`,
        )
        .get(versionId, memoryId),
    );
  }

  private writeTombstone(memoryId: string): void {
    this.core.db
      .prepare(
        "INSERT OR REPLACE INTO deletion_tombstones(memory_id,deleted_at) VALUES (?,?)",
      )
      .run(memoryId, now());
  }

  private purgeCandidateLinks(memoryId: string): void {
    const jobs = this.core.db
      .prepare(
        `SELECT DISTINCT refine_job_id FROM candidates
         WHERE applied_memory_id=? OR target_id=?`,
      )
      .all(memoryId, memoryId) as unknown as Array<{ refine_job_id: string }>;
    this.core.db
      .prepare("DELETE FROM candidates WHERE applied_memory_id=? OR target_id=?")
      .run(memoryId, memoryId);
    for (const job of jobs) {
      const remaining = row<{ count: number }>(
        this.core.db
          .prepare("SELECT count(*) AS count FROM candidates WHERE refine_job_id=?")
          .get(job.refine_job_id),
      );
      if (Number(remaining?.count ?? 0) === 0) {
        this.core.db
          .prepare("DELETE FROM refine_jobs WHERE id=?")
          .run(job.refine_job_id);
      }
    }
  }
}

interface RollbackTarget {
  repo_id: string;
  content: string;
  version_no: number;
  active_version_no: number;
}
