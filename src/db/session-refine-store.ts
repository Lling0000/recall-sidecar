import { randomUUID } from "node:crypto";
import type { StagedTurnCandidate } from "../model/session-types.js";
import type { ExtractResult } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { now, parseCard, row } from "./helpers.js";
import type { JobStore } from "./job-store.js";
import type { ClaimedSessionRefineJob, SessionRefineBatch } from "./types.js";

const DEFAULT_BATCH_SIZE = 25;

export class SessionRefineStore {
  constructor(
    private readonly core: DatabaseCore,
    private readonly jobs: JobStore,
  ) {}

  stage(
    refineJobId: string,
    repoId: string,
    sessionId: string,
    nativeTurnRef: string,
    result: ExtractResult,
    revision: number,
  ): void {
    this.core.transaction(() => {
      const timestamp = now();
      this.core.db
        .prepare(
          `INSERT OR IGNORE INTO turn_candidates(
            refine_job_id,repo_id,session_id,native_turn_ref,action,target_id,
            base_version,revision,content,state,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,'staged',?,?)`,
        )
        .run(
          refineJobId,
          repoId,
          sessionId,
          nativeTurnRef,
          result.action,
          result.target_memory_id,
          result.base_version,
          revision,
          result.memory ? JSON.stringify(result.memory) : null,
          timestamp,
          timestamp,
        );
      this.jobs.complete(refineJobId);
      this.core.audit("turn_candidate_staged", refineJobId, {
        repo_id: repoId,
        action: result.action,
      });
    });
  }

  enqueue(
    sessionId: string,
    repoId: string,
    reason: "turn_interval" | "compact",
    threshold = DEFAULT_BATCH_SIZE,
  ): string | null {
    return this.core.transaction(() => {
      const staged = this.stagedCount(sessionId);
      if (staged === 0 || (reason === "turn_interval" && staged < threshold)) {
        return null;
      }
      const existing = row<{ id: string }>(
        this.core.db
          .prepare(
            `SELECT id FROM session_refine_jobs
             WHERE session_id=? AND state IN ('queued','running') LIMIT 1`,
          )
          .get(sessionId),
      );
      if (existing) return existing.id;
      const id = randomUUID();
      const timestamp = now();
      this.core.db
        .prepare(
          `INSERT INTO session_refine_jobs(
            id,session_id,repo_id,reason,state,created_at,updated_at
          ) VALUES (?,?,?,?,'queued',?,?)`,
        )
        .run(id, sessionId, repoId, reason, timestamp, timestamp);
      this.core.audit("session_refine_enqueued", id, {
        repo_id: repoId,
        reason,
        staged,
      });
      return id;
    });
  }

  claimNext(): ClaimedSessionRefineJob | null {
    return this.core.transaction(() => {
      const candidate = row<{ id: string }>(
        this.core.db
          .prepare(
            `SELECT sr.id FROM session_refine_jobs sr
             WHERE sr.state='queued' AND NOT EXISTS (
               SELECT 1 FROM session_refine_jobs running
               WHERE running.state='running' AND running.repo_id=sr.repo_id
             ) ORDER BY sr.created_at LIMIT 1`,
          )
          .get(),
      );
      if (!candidate) return null;
      this.core.db
        .prepare(
          `UPDATE session_refine_jobs SET state='running',attempts=attempts+1,
           updated_at=? WHERE id=? AND state='queued'`,
        )
        .run(now(), candidate.id);
      return row<ClaimedSessionRefineJob>(
        this.core.db
          .prepare(
            `SELECT sr.id AS jobId,sr.session_id AS sessionId,
              s.native_session_ref AS nativeSessionRef,sr.repo_id AS repoId,
              s.transcript_path AS transcriptPath,sr.reason,sr.attempts
             FROM session_refine_jobs sr JOIN sessions s ON s.id=sr.session_id
             WHERE sr.id=? AND s.transcript_path IS NOT NULL`,
          )
          .get(candidate.id),
      );
    });
  }

  batch(job: ClaimedSessionRefineJob, limit = DEFAULT_BATCH_SIZE): SessionRefineBatch {
    const rows = this.core.db
      .prepare(
        `SELECT refine_job_id,native_turn_ref,action,target_id,base_version,content
         FROM turn_candidates WHERE session_id=? AND state='staged'
         ORDER BY created_at LIMIT ?`,
      )
      .all(job.sessionId, limit) as unknown as StagedCandidateRow[];
    return { job, candidates: rows.map(toCandidate) };
  }

  finish(
    jobId: string,
    batchJobIds: readonly string[],
    consumedJobIds: ReadonlySet<string>,
    refined: boolean,
  ): void {
    this.core.transaction(() => {
      const timestamp = now();
      const statement = this.core.db.prepare(
        "UPDATE turn_candidates SET state=?,updated_at=? WHERE refine_job_id=? AND state='staged'",
      );
      for (const id of batchJobIds) {
        statement.run(consumedJobIds.has(id) ? "consumed" : "dismissed", timestamp, id);
      }
      this.core.db
        .prepare(
          "UPDATE session_refine_jobs SET state=?,last_error=NULL,updated_at=? WHERE id=?",
        )
        .run(refined ? "completed" : "skipped", timestamp, jobId);
      this.core.audit(
        refined ? "session_refine_completed" : "session_refine_skipped",
        jobId,
        {
          consumed: consumedJobIds.size,
          batch_size: batchJobIds.length,
        },
      );
    });
  }

  fail(jobId: string, code: string): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(
          `UPDATE session_refine_jobs SET state='failed',last_error=?,updated_at=?
           WHERE id=?`,
        )
        .run(code, now(), jobId);
      this.core.audit("session_refine_failed", jobId, { error: code });
    });
  }

  stagedCount(sessionId: string): number {
    return Number(
      row<{ count: number }>(
        this.core.db
          .prepare(
            "SELECT count(*) AS count FROM turn_candidates WHERE session_id=? AND state='staged'",
          )
          .get(sessionId),
      )?.count ?? 0,
    );
  }
}

interface StagedCandidateRow {
  refine_job_id: string;
  native_turn_ref: string;
  action: StagedTurnCandidate["action"];
  target_id: string | null;
  base_version: number | null;
  content: string | null;
}

function toCandidate(value: StagedCandidateRow): StagedTurnCandidate {
  return {
    job_id: value.refine_job_id,
    turn_id: value.native_turn_ref,
    action: value.action,
    target_memory_id: value.target_id,
    base_version: value.base_version,
    memory: value.content ? parseCard(value.content) : null,
  };
}
