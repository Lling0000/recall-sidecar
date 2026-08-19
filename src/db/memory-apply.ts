import { randomUUID } from "node:crypto";
import type {
  SessionRefinerEdit,
  StagedTurnCandidate,
} from "../model/session-types.js";
import { validateMemoryCard } from "../security/memory-card.js";
import type { ExtractResult, MemoryCard } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { replaceMemoryFts } from "./fts-writer.js";
import { now, row, topicKey } from "./helpers.js";
import type { JobStore } from "./job-store.js";
import { applySessionEdits } from "./memory-session-apply.js";
import { recordStaleCandidate } from "./memory-stale.js";
import type { AppliedCandidate } from "./types.js";

export class MemoryApplyStore {
  constructor(
    private readonly core: DatabaseCore,
    private readonly jobs: JobStore,
  ) {}

  apply(
    jobId: string,
    repoId: string,
    result: ExtractResult,
    sourceSessionId: string,
    sourceTurnRef: string,
    revision: number,
  ): AppliedCandidate {
    return this.core.transaction(() => {
      const existing = this.existing(jobId);
      if (existing) return existing;
      if (result.action === "create") {
        return this.create(
          jobId,
          repoId,
          validateMemoryCard(result.memory),
          sourceSessionId,
          sourceTurnRef,
          revision,
        );
      }
      if (result.action === "update") {
        return this.update(
          jobId,
          repoId,
          result,
          validateMemoryCard(result.memory),
          sourceSessionId,
          sourceTurnRef,
          revision,
        );
      }
      return this.skip(jobId, repoId, result.action, revision);
    });
  }

  applySessionRefinement(
    repoId: string,
    sessionId: string,
    edits: readonly SessionRefinerEdit[],
    candidates: readonly StagedTurnCandidate[],
  ): AppliedCandidate[] {
    return applySessionEdits(edits, candidates, {
      transaction: (operation) => this.core.transaction(operation),
      existing: (jobId) => this.existing(jobId),
      updateIsCurrent: (edit) => {
        const target = edit.target_memory_id
          ? this.activeTarget(edit.target_memory_id)
          : null;
        return Boolean(
          target &&
            target.repo_id === repoId &&
            target.state === "active" &&
            target.version_no === edit.base_version,
        );
      },
      create: (source, edit) => {
        if (edit.target_memory_id !== null || edit.base_version !== null) {
          throw new Error("session_refine_create_semantics");
        }
        return this.create(
          source.job_id,
          repoId,
          validateMemoryCard(edit.memory),
          sessionId,
          edit.source_turn_id,
          2,
        );
      },
      update: (source, edit) => {
        const card = validateMemoryCard(edit.memory);
        return this.update(
          source.job_id,
          repoId,
          {
            action: "update",
            target_memory_id: edit.target_memory_id,
            base_version: edit.base_version,
            memory: card,
          },
          card,
          sessionId,
          edit.source_turn_id,
          2,
        );
      },
    });
  }

  private existing(jobId: string): AppliedCandidate | null {
    const candidate = row<{
      id: string;
      state: AppliedCandidate["state"];
      applied_memory_id: string | null;
    }>(
      this.core.db
        .prepare(
          "SELECT id,state,applied_memory_id FROM candidates WHERE refine_job_id=?",
        )
        .get(jobId),
    );
    if (!candidate) return null;
    const version = candidate.applied_memory_id
      ? (row<{ version_no: number }>(
          this.core.db
            .prepare(
              `SELECT mv.version_no FROM memories m JOIN memory_versions mv
               ON mv.id=m.active_version_id WHERE m.id=?`,
            )
            .get(candidate.applied_memory_id),
        )?.version_no ?? null)
      : null;
    return {
      candidateId: candidate.id,
      state: candidate.state,
      memoryId: candidate.applied_memory_id,
      version,
    };
  }

  private skip(
    jobId: string,
    repoId: string,
    action: ExtractResult["action"],
    revision: number,
  ): AppliedCandidate {
    const candidateId = randomUUID();
    this.core.db
      .prepare(
        `INSERT INTO candidates(
          id,refine_job_id,repo_id,action,target_id,base_version,revision,
          content,state,review_state,created_at
        ) VALUES (?,?,?,?,?,?,?,NULL,'skipped','none',?)`,
      )
      .run(candidateId, jobId, repoId, action, null, null, revision, now());
    this.jobs.complete(jobId);
    this.core.audit(`extract_${action}`, candidateId, { repo_id: repoId });
    return {
      candidateId,
      state: "skipped",
      memoryId: null,
      version: null,
    };
  }

  private create(
    jobId: string,
    repoId: string,
    card: MemoryCard,
    sourceSessionId: string,
    sourceTurnRef: string,
    revision: number,
  ): AppliedCandidate {
    const timestamp = now();
    const candidateId = randomUUID();
    const memoryId = randomUUID();
    const versionId = randomUUID();
    const content = JSON.stringify(card);
    this.core.db
      .prepare(
        `INSERT INTO memories(
          id,repo_id,active_version_id,topic_key,state,created_at,updated_at
        ) VALUES (?,?,NULL,?,'active',?,?)`,
      )
      .run(memoryId, repoId, topicKey(card.title), timestamp, timestamp);
    this.core.db
      .prepare(
        `INSERT INTO memory_versions(
          id,memory_id,version_no,content,source_session_id,source_turn_ref,created_at
        ) VALUES (?,?,1,?,?,?,?)`,
      )
      .run(versionId, memoryId, content, sourceSessionId, sourceTurnRef, timestamp);
    this.core.db
      .prepare("UPDATE memories SET active_version_id=? WHERE id=?")
      .run(versionId, memoryId);
    replaceMemoryFts(this.core, memoryId, repoId, card);
    this.core.db
      .prepare(
        `INSERT INTO candidates(
          id,refine_job_id,repo_id,action,target_id,applied_memory_id,
          base_version,revision,content,state,review_state,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'applied','unverified',?)`,
      )
      .run(
        candidateId,
        jobId,
        repoId,
        "create",
        null,
        memoryId,
        null,
        revision,
        content,
        timestamp,
      );
    this.finishApplied(jobId, repoId, "memory_created", memoryId, 1);
    return { candidateId, state: "applied", memoryId, version: 1 };
  }

  private update(
    jobId: string,
    repoId: string,
    result: ExtractResult,
    card: MemoryCard,
    sourceSessionId: string,
    sourceTurnRef: string,
    revision: number,
  ): AppliedCandidate {
    const targetId = result.target_memory_id;
    const baseVersion = result.base_version;
    if (!targetId || !baseVersion) throw new Error("update_semantics");
    const target = this.activeTarget(targetId);
    if (
      !target ||
      target.repo_id !== repoId ||
      target.state !== "active" ||
      target.version_no !== baseVersion
    ) {
      return recordStaleCandidate(
        this.core,
        this.jobs,
        jobId,
        repoId,
        targetId,
        baseVersion,
        card,
        revision,
      );
    }

    const timestamp = now();
    const candidateId = randomUUID();
    const versionId = randomUUID();
    const versionNo = target.version_no + 1;
    const content = JSON.stringify(card);
    this.core.db
      .prepare(
        `INSERT INTO memory_versions(
          id,memory_id,version_no,content,source_session_id,source_turn_ref,created_at
        ) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        versionId,
        targetId,
        versionNo,
        content,
        sourceSessionId,
        sourceTurnRef,
        timestamp,
      );
    this.core.db
      .prepare(
        `UPDATE memories SET active_version_id=?,topic_key=?,state='active',updated_at=?
         WHERE id=?`,
      )
      .run(versionId, topicKey(card.title), timestamp, targetId);
    replaceMemoryFts(this.core, targetId, repoId, card);
    this.core.db
      .prepare(
        `INSERT INTO candidates(
          id,refine_job_id,repo_id,action,target_id,applied_memory_id,
          base_version,revision,content,state,review_state,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'applied','unverified',?)`,
      )
      .run(
        candidateId,
        jobId,
        repoId,
        "update",
        targetId,
        targetId,
        baseVersion,
        revision,
        content,
        timestamp,
      );
    this.finishApplied(jobId, repoId, "memory_updated", targetId, versionNo);
    return {
      candidateId,
      state: "applied",
      memoryId: targetId,
      version: versionNo,
    };
  }

  private activeTarget(memoryId: string): TargetRow | null {
    return row<TargetRow>(
      this.core.db
        .prepare(
          `SELECT m.id,m.repo_id,m.state,mv.version_no
           FROM memories m JOIN memory_versions mv ON mv.id=m.active_version_id
           LEFT JOIN deletion_tombstones d ON d.memory_id=m.id
           WHERE m.id=? AND d.memory_id IS NULL`,
        )
        .get(memoryId),
    );
  }

  private finishApplied(
    jobId: string,
    repoId: string,
    action: string,
    memoryId: string,
    version: number,
  ): void {
    this.core.bumpGeneration(repoId);
    this.jobs.complete(jobId);
    this.core.audit(action, memoryId, { repo_id: repoId, version });
  }
}

interface TargetRow {
  id: string;
  repo_id: string;
  state: string;
  version_no: number;
}
