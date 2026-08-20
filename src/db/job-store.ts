import { randomUUID } from "node:crypto";
import type { DatabaseCore } from "./core.js";
import { now, row } from "./helpers.js";
import type { EnqueuedJob } from "./types.js";

export class JobStore {
  constructor(private readonly core: DatabaseCore) {}

  captureStop(
    sessionId: string,
    repoId: string,
    nativeTurnRef: string,
    transcriptPath: string,
    capture: boolean,
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
          capture ? "captured" : "skipped",
          timestamp,
        );
      this.core.db
        .prepare("UPDATE sessions SET transcript_path=? WHERE id=?")
        .run(transcriptPath, sessionId);
      if (!capture) return { turnId, jobId: null, duplicate: false };
      const jobId = randomUUID();
      this.core.db
        .prepare(
          `INSERT INTO refine_jobs(id,turn_id,state,created_at,updated_at)
           VALUES (?,?,'captured',?,?)`,
        )
        .run(jobId, turnId, timestamp, timestamp);
      this.core.db
        .prepare(
          `INSERT INTO session_turn_queue(
            turn_id,session_id,repo_id,refine_job_id,state,captured_at
          ) VALUES (?,?,?,?, 'pending',?)`,
        )
        .run(turnId, sessionId, repoId, jobId, timestamp);
      return { turnId, jobId, duplicate: false };
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
