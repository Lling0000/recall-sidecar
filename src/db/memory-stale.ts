import { randomUUID } from "node:crypto";
import type { MemoryCard } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { now } from "./helpers.js";
import type { JobStore } from "./job-store.js";
import type { AppliedCandidate } from "./types.js";

export function recordStaleCandidate(
  core: DatabaseCore,
  jobs: JobStore,
  jobId: string,
  editOrdinal: number,
  repoId: string,
  targetId: string,
  baseVersion: number,
  card: MemoryCard,
  revision: number,
): AppliedCandidate {
  const candidateId = randomUUID();
  core.db
    .prepare(
      `INSERT INTO candidates(
        id,refine_job_id,edit_ordinal,repo_id,action,target_id,base_version,revision,
        content,state,review_state,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'stale','none',?)`,
    )
    .run(
      candidateId,
      jobId,
      editOrdinal,
      repoId,
      "update",
      targetId,
      baseVersion,
      revision,
      JSON.stringify(card),
      now(),
    );
  jobs.complete(jobId);
  core.audit("candidate_stale", targetId, { repo_id: repoId });
  return { candidateId, state: "stale", memoryId: null, version: null };
}
