import { randomUUID } from "node:crypto";
import type { DatabaseCore } from "./core.js";
import { now, row } from "./helpers.js";
import type { ClaimedJob, EnqueuedJob } from "./types.js";

export class JobStore {
  constructor(private readonly core: DatabaseCore) {}

  enqueueStop(
    sessionId: string,
    nativeTurnRef: string,
    transcriptPath: string,
    createJob: boolean,
  ): EnqueuedJob {
    return this.core.transaction(() => {
      const duplicate = row<{ id: string }>(
        this.core.db
          .prepare("SELECT id FROM turns WHERE session_id=? AND native_turn_ref=?")
          .get(sessionId, nativeTurnRef),
      );
      if (duplicate) return this.existingEnqueue(duplicate.id);

      const timestamp = now();
      const turnId = randomUUID();
      this.core.db
        .prepare(
          "INSERT INTO turns(id,session_id,native_turn_ref,state,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          turnId,
          sessionId,
          nativeTurnRef,
          createJob ? "queued" : "skipped",
          timestamp,
        );
      this.core.db
        .prepare("UPDATE sessions SET transcript_path=? WHERE id=?")
        .run(transcriptPath, sessionId);
      if (!createJob) return { turnId, jobId: null, duplicate: false };

      const jobId = randomUUID();
      this.core.db
        .prepare(
          "INSERT INTO refine_jobs(id,turn_id,state,created_at,updated_at) VALUES (?,?,'queued',?,?)",
        )
        .run(jobId, turnId, timestamp, timestamp);
      return { turnId, jobId, duplicate: false };
    });
  }

  claimNext(leaseMilliseconds = 60_000): ClaimedJob | null {
    return this.core.transaction(() => {
      const candidate = row<{ id: string }>(
        this.core.db
          .prepare(
            `SELECT j.id FROM refine_jobs j
             JOIN turns t ON t.id=j.turn_id
             JOIN sessions s ON s.id=t.session_id
             WHERE j.state='queued' AND NOT EXISTS (
               SELECT 1 FROM refine_jobs running
               JOIN turns rt ON rt.id=running.turn_id
               JOIN sessions rs ON rs.id=rt.session_id
               WHERE running.state='running' AND rs.repo_id=s.repo_id
             ) ORDER BY j.created_at LIMIT 1`,
          )
          .get(),
      );
      if (!candidate) return null;
      this.core.db
        .prepare(
          `UPDATE refine_jobs SET state='running',attempts=attempts+1,
             lease_expires_at=?,updated_at=? WHERE id=? AND state='queued'`,
        )
        .run(
          new Date(Date.now() + leaseMilliseconds).toISOString(),
          now(),
          candidate.id,
        );
      return row<ClaimedJob>(
        this.core.db
          .prepare(
            `SELECT j.id AS jobId,t.id AS turnId,t.native_turn_ref AS nativeTurnRef,
              s.repo_id AS repoId,s.id AS sessionId,
              s.native_session_ref AS nativeSessionRef,
              s.transcript_path AS transcriptPath,j.attempts AS attempts
             FROM refine_jobs j JOIN turns t ON t.id=j.turn_id
             JOIN sessions s ON s.id=t.session_id
             WHERE j.id=? AND s.transcript_path IS NOT NULL`,
          )
          .get(candidate.id),
      );
    });
  }

  recordProjection(
    turnId: string,
    sourceDigest: string,
    projectionVersion: string,
  ): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(
          "UPDATE turns SET source_digest=?,projection_version=?,state='projected' WHERE id=?",
        )
        .run(sourceDigest, projectionVersion, turnId);
    });
  }

  fail(jobId: string, errorCode: string): void {
    this.core.transaction(() => {
      this.core.db
        .prepare(
          "UPDATE refine_jobs SET state='failed',last_error=?,lease_expires_at=NULL,updated_at=? WHERE id=?",
        )
        .run(errorCode, now(), jobId);
      this.core.db
        .prepare(
          "UPDATE turns SET state='failed' WHERE id=(SELECT turn_id FROM refine_jobs WHERE id=?)",
        )
        .run(jobId);
    });
  }

  complete(jobId: string): void {
    this.core.db
      .prepare(
        "UPDATE refine_jobs SET state='completed',lease_expires_at=NULL,updated_at=? WHERE id=?",
      )
      .run(now(), jobId);
  }

  private existingEnqueue(turnId: string): EnqueuedJob {
    const job = row<{ id: string }>(
      this.core.db.prepare("SELECT id FROM refine_jobs WHERE turn_id=?").get(turnId),
    );
    return { turnId, jobId: job?.id ?? null, duplicate: true };
  }
}
