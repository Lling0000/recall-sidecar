import { randomUUID } from "node:crypto";
import type { DatabaseCore } from "./core.js";
import { now, row } from "./helpers.js";
import type { ClaimedSessionRefineJob, SessionRefineBatch } from "./types.js";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_OVERLAP_SIZE = 5;

export class SessionRefineStore {
  constructor(private readonly core: DatabaseCore) {}

  enqueue(
    sessionId: string,
    repoId: string,
    reason: "turn_interval" | "compact",
    threshold = DEFAULT_BATCH_SIZE,
    overlapSize = DEFAULT_OVERLAP_SIZE,
  ): string | null {
    return this.core.transaction(() => {
      const existing = this.activeJob(sessionId);
      if (existing) return existing;
      const eligible = this.pendingTurns(sessionId, threshold);
      if (
        eligible.length === 0 ||
        (reason === "turn_interval" && eligible.length < threshold)
      ) {
        return null;
      }
      const overlap = this.overlapTurns(
        sessionId,
        eligible[0]?.queue_rowid,
        overlapSize,
      );
      const id = randomUUID();
      const timestamp = now();
      this.core.db
        .prepare(
          `INSERT INTO session_refine_jobs(
            id,session_id,repo_id,reason,state,created_at,updated_at
          ) VALUES (?,?,?,?,'queued',?,?)`,
        )
        .run(id, sessionId, repoId, reason, timestamp, timestamp);
      const insert = this.core.db.prepare(
        `INSERT INTO session_refine_job_turns(
          session_refine_job_id,turn_id,role,ordinal
        ) VALUES (?,?,?,?)`,
      );
      let ordinal = 0;
      for (const turn of overlap) insert.run(id, turn.turn_id, "overlap", ordinal++);
      for (const turn of eligible) insert.run(id, turn.turn_id, "eligible", ordinal++);
      this.core.audit("session_refine_enqueued", id, {
        repo_id: repoId,
        reason,
        eligible: eligible.length,
        overlap: overlap.length,
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

  batch(job: ClaimedSessionRefineJob): SessionRefineBatch {
    const turns = this.core.db
      .prepare(
        `SELECT jt.turn_id AS internal_turn_id,t.native_turn_ref AS turn_id,
          q.refine_job_id AS job_id,jt.role
         FROM session_refine_job_turns jt
         JOIN turns t ON t.id=jt.turn_id
         JOIN session_turn_queue q ON q.turn_id=jt.turn_id
         WHERE jt.session_refine_job_id=? ORDER BY jt.ordinal`,
      )
      .all(job.jobId) as unknown as SessionRefineBatch["turns"];
    return { job, turns };
  }

  finish(jobId: string, processedTurnIds: ReadonlySet<string>, refined: boolean): void {
    this.core.transaction(() => {
      const timestamp = now();
      const update = this.core.db.prepare(
        `UPDATE session_turn_queue SET state='processed',processed_at=?
         WHERE turn_id=? AND state='pending'`,
      );
      const completeCapture = this.core.db.prepare(
        `UPDATE refine_jobs SET state='completed',updated_at=?
         WHERE id=(SELECT refine_job_id FROM session_turn_queue WHERE turn_id=?)`,
      );
      for (const turnId of processedTurnIds) {
        update.run(timestamp, turnId);
        completeCapture.run(timestamp, turnId);
      }
      this.core.db
        .prepare(
          "UPDATE session_refine_jobs SET state=?,last_error=NULL,updated_at=? WHERE id=?",
        )
        .run(refined ? "completed" : "skipped", timestamp, jobId);
      this.core.audit(
        refined ? "session_refine_completed" : "session_refine_skipped",
        jobId,
        { processed: processedTurnIds.size },
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

  pendingCount(sessionId: string): number {
    return Number(
      row<{ count: number }>(
        this.core.db
          .prepare(
            "SELECT count(*) AS count FROM session_turn_queue WHERE session_id=? AND state='pending'",
          )
          .get(sessionId),
      )?.count ?? 0,
    );
  }

  private activeJob(sessionId: string): string | null {
    return (
      row<{ id: string }>(
        this.core.db
          .prepare(
            `SELECT id FROM session_refine_jobs
             WHERE session_id=? AND state IN ('queued','running') LIMIT 1`,
          )
          .get(sessionId),
      )?.id ?? null
    );
  }

  private pendingTurns(sessionId: string, limit: number): QueuedTurn[] {
    return this.core.db
      .prepare(
        `SELECT turn_id,captured_at,rowid AS queue_rowid FROM session_turn_queue
         WHERE session_id=? AND state='pending'
         ORDER BY captured_at,rowid LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as QueuedTurn[];
  }

  private overlapTurns(
    sessionId: string,
    beforeRowId: number | undefined,
    limit: number,
  ): QueuedTurn[] {
    if (!beforeRowId || limit <= 0) return [];
    const rows = this.core.db
      .prepare(
        `SELECT turn_id,captured_at,rowid AS queue_rowid FROM session_turn_queue
         WHERE session_id=? AND state='processed' AND rowid<?
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(sessionId, beforeRowId, limit) as unknown as QueuedTurn[];
    return rows.reverse();
  }
}

interface QueuedTurn {
  turn_id: string;
  captured_at: string;
  queue_rowid: number;
}
