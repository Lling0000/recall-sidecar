import { createHash, randomUUID } from "node:crypto";
import type { ConsolidationSuggestion } from "../model/consolidation-types.js";
import { validateMemoryCard } from "../security/memory-card.js";
import type { CompareCard } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { parseCard, row } from "./helpers.js";
import type { ClaimedConsolidationJob } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export class KnowledgeConsolidationStore {
  constructor(
    private readonly core: DatabaseCore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  enqueueDue(): number {
    const repositories = this.core.db
      .prepare(
        `SELECT r.id FROM repositories r JOIN memories m ON m.repo_id=r.id
         WHERE m.state='active' GROUP BY r.id HAVING count(*)>=2`,
      )
      .all() as unknown as Array<{ id: string }>;
    let count = 0;
    for (const repository of repositories) {
      const last = this.core.getSetting(lastRunKey(repository.id));
      const lastTime = last ? Date.parse(last) : Number.NaN;
      if (Number.isFinite(lastTime) && this.clock().getTime() - lastTime < DAY_MS) {
        continue;
      }
      if (this.enqueue(repository.id)) count += 1;
    }
    return count;
  }

  enqueue(repoId: string): string | null {
    return this.core.transaction(() => {
      const eligible = row<{ count: number }>(
        this.core.db
          .prepare(
            "SELECT count(*) AS count FROM memories WHERE repo_id=? AND state='active'",
          )
          .get(repoId),
      );
      if (Number(eligible?.count ?? 0) < 2) return null;
      const existing = row<{ id: string }>(
        this.core.db
          .prepare(
            "SELECT id FROM knowledge_consolidation_jobs WHERE repo_id=? AND state IN ('queued','running')",
          )
          .get(repoId),
      );
      if (existing) return null;
      const id = randomUUID();
      const timestamp = this.timestamp();
      this.core.db
        .prepare(
          `INSERT INTO knowledge_consolidation_jobs(
            id,repo_id,state,attempts,created_at,updated_at
          ) VALUES (?,?,'queued',0,?,?)`,
        )
        .run(id, repoId, timestamp, timestamp);
      return id;
    });
  }

  claimNext(): ClaimedConsolidationJob | null {
    return this.core.transaction(() => {
      const job = row<{ id: string; repo_id: string; attempts: number }>(
        this.core.db
          .prepare(
            "SELECT id,repo_id,attempts FROM knowledge_consolidation_jobs WHERE state='queued' ORDER BY created_at LIMIT 1",
          )
          .get(),
      );
      if (!job) return null;
      this.core.db
        .prepare(
          "UPDATE knowledge_consolidation_jobs SET state='running',attempts=attempts+1,updated_at=? WHERE id=?",
        )
        .run(this.timestamp(), job.id);
      return { jobId: job.id, repoId: job.repo_id, attempts: job.attempts + 1 };
    });
  }

  activeMemories(repoId: string): CompareCard[] {
    const values = this.core.db
      .prepare(
        `SELECT m.id,mv.version_no,mv.content FROM memories m
         JOIN memory_versions mv ON mv.id=m.active_version_id
         WHERE m.repo_id=? AND m.state='active' ORDER BY m.updated_at,m.id`,
      )
      .all(repoId) as unknown as Array<{
      id: string;
      version_no: number;
      content: string;
    }>;
    return values.map((value) => ({
      id: value.id,
      version: value.version_no,
      ...parseCard(value.content),
    }));
  }

  complete(jobId: string, suggestions: readonly ConsolidationSuggestion[]): void {
    this.core.transaction(() => {
      const job = this.runningJob(jobId);
      const timestamp = this.timestamp();
      for (const suggestion of suggestions) {
        const proposed = suggestion.proposed_memory
          ? JSON.stringify(validateMemoryCard(suggestion.proposed_memory))
          : null;
        this.core.db
          .prepare(
            `INSERT OR IGNORE INTO knowledge_consolidation_suggestions(
              id,job_id,repo_id,kind,target_memory_id,target_base_version,
              related_json,proposed_content,reason,fingerprint,state,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
          )
          .run(
            randomUUID(),
            jobId,
            job.repo_id,
            suggestion.kind,
            suggestion.target_memory_id,
            suggestion.target_base_version,
            JSON.stringify(suggestion.related_memories),
            proposed,
            suggestion.reason,
            fingerprint(suggestion),
            timestamp,
            timestamp,
          );
      }
      this.core.db
        .prepare(
          "UPDATE knowledge_consolidation_jobs SET state='completed',last_error=NULL,updated_at=? WHERE id=?",
        )
        .run(timestamp, jobId);
      this.putLastRun(job.repo_id, timestamp);
      this.core.audit("knowledge_consolidation_completed", jobId, {
        repo_id: job.repo_id,
        suggestions: suggestions.length,
      });
    });
  }

  fail(jobId: string, errorCode: string): void {
    this.core.transaction(() => {
      const job = this.runningJob(jobId);
      const timestamp = this.timestamp();
      this.core.db
        .prepare(
          "UPDATE knowledge_consolidation_jobs SET state='failed',last_error=?,updated_at=? WHERE id=?",
        )
        .run(errorCode, timestamp, jobId);
      this.putLastRun(job.repo_id, timestamp);
      this.core.audit("knowledge_consolidation_failed", jobId, {
        repo_id: job.repo_id,
        error: errorCode,
      });
    });
  }

  health(): { pending: number; failed: number } {
    const count = (sql: string): number =>
      Number(row<{ count: number }>(this.core.db.prepare(sql).get())?.count ?? 0);
    return {
      pending: count(
        "SELECT count(*) AS count FROM knowledge_consolidation_suggestions WHERE state='pending'",
      ),
      failed: count(
        "SELECT count(*) AS count FROM knowledge_consolidation_jobs WHERE state='failed'",
      ),
    };
  }

  clearResolvedFailures(): number {
    return this.core.transaction(() => {
      const result = this.core.db
        .prepare("DELETE FROM knowledge_consolidation_jobs WHERE state='failed'")
        .run();
      const count = Number(result.changes);
      if (count > 0) {
        this.core.audit("knowledge_consolidation_failures_cleared", null, {
          count,
        });
      }
      return count;
    });
  }

  private runningJob(jobId: string): { repo_id: string } {
    const job = row<{ repo_id: string }>(
      this.core.db
        .prepare(
          "SELECT repo_id FROM knowledge_consolidation_jobs WHERE id=? AND state='running'",
        )
        .get(jobId),
    );
    if (!job) throw new Error("consolidation_job_not_running");
    return job;
  }

  private putLastRun(repoId: string, timestamp: string): void {
    this.core.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(lastRunKey(repoId), timestamp);
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}

function fingerprint(suggestion: ConsolidationSuggestion): string {
  const source = [
    suggestion.kind,
    ...[
      `${suggestion.target_memory_id}@${suggestion.target_base_version}`,
      ...suggestion.related_memories.map(
        (memory) => `${memory.memory_id}@${memory.base_version}`,
      ),
    ].sort(),
  ].join("|");
  return createHash("sha256").update(source).digest("hex");
}

function lastRunKey(repoId: string): string {
  return `last_consolidation_at:${repoId}`;
}
