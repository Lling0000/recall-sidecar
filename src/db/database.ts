import { dirname, join } from "node:path";
import type { ExtractResult, RepoIdentity } from "../types.js";
import { BackupStore } from "./backup-store.js";
import { DatabaseCore } from "./core.js";
import { JobStore } from "./job-store.js";
import { MemoryAdminStore } from "./memory-admin.js";
import { MemoryApplyStore } from "./memory-apply.js";
import { MemoryQueryStore } from "./memory-query.js";
import { ModelSettingsStore } from "./model-settings.js";
import { RepositoryStore } from "./repository-store.js";
import type {
  AppliedCandidate,
  BoundSession,
  ClaimedJob,
  EnqueuedJob,
  ListedMemory,
  ListedRepository,
  ListedVersion,
  PendingReview,
} from "./types.js";

/** Thin facade; storage concerns remain in dedicated modules. */
export class MemoryDatabase {
  readonly core: DatabaseCore;
  private readonly repositories: RepositoryStore;
  private readonly jobs: JobStore;
  private readonly queries: MemoryQueryStore;
  private readonly applyStore: MemoryApplyStore;
  private readonly admin: MemoryAdminStore;
  readonly modelSettings: ModelSettingsStore;
  private readonly backups: BackupStore;

  constructor(path: string) {
    this.core = new DatabaseCore(path);
    this.repositories = new RepositoryStore(this.core);
    this.jobs = new JobStore(this.core);
    this.queries = new MemoryQueryStore(this.core);
    this.applyStore = new MemoryApplyStore(this.core, this.jobs);
    this.admin = new MemoryAdminStore(this.core);
    this.modelSettings = new ModelSettingsStore(this.core);
    this.backups = new BackupStore(this.core, join(dirname(path), "backups"));
  }

  close(): void {
    this.core.close();
  }

  quickCheck(): boolean {
    return this.core.quickCheck();
  }

  setSetting(key: string, value: string): void {
    this.core.setSetting(key, value);
  }

  getSetting(key: string): string | null {
    return this.core.getSetting(key);
  }

  extractionEnabled(): boolean {
    return this.core.extractionEnabled();
  }

  bindSession(
    client: string,
    nativeSessionRef: string,
    identity: RepoIdentity,
    transcriptPath: string | null = null,
  ): BoundSession {
    return this.repositories.bindSession(
      client,
      nativeSessionRef,
      identity,
      transcriptPath,
    );
  }

  getBoundSession(client: string, nativeSessionRef: string): BoundSession | null {
    return this.repositories.getBoundSession(client, nativeSessionRef);
  }

  enqueueStop(
    sessionId: string,
    nativeTurnRef: string,
    transcriptPath: string,
    createJob: boolean,
  ): EnqueuedJob {
    return this.jobs.enqueueStop(sessionId, nativeTurnRef, transcriptPath, createJob);
  }

  claimNextJob(): ClaimedJob | null {
    return this.jobs.claimNext();
  }

  recordProjection(turnId: string, digest: string, version: string): void {
    this.jobs.recordProjection(turnId, digest, version);
  }

  markJobFailed(jobId: string, errorCode: string): void {
    this.jobs.fail(jobId, errorCode);
  }

  searchCards(repoId: string, prompt: string, limit?: number) {
    return this.queries.search(repoId, prompt, limit);
  }

  recall(repoId: string, prompt: string): string {
    return this.queries.recall(repoId, prompt);
  }

  applyExtractResult(
    jobId: string,
    repoId: string,
    result: ExtractResult,
    sourceSessionId: string,
    sourceTurnRef: string,
    revision: number,
  ): AppliedCandidate {
    return this.applyStore.apply(
      jobId,
      repoId,
      result,
      sourceSessionId,
      sourceTurnRef,
      revision,
    );
  }

  confirmCandidate(candidateId: string): void {
    this.admin.confirmCandidate(candidateId);
  }

  rollbackMemory(memoryId: string, versionId: string): number {
    return this.admin.rollback(memoryId, versionId);
  }

  archiveMemory(memoryId: string): void {
    this.admin.archive(memoryId);
  }

  hardDeleteMemory(memoryId: string): void {
    this.admin.hardDelete(memoryId);
    this.backups.purgeAll();
  }

  listRepositories(): ListedRepository[] {
    return this.repositories.list();
  }

  repositoryPaused(repoId: string): boolean {
    return this.repositories.isPaused(repoId);
  }

  setRepositoryPaused(repoId: string, paused: boolean): void {
    this.repositories.setPaused(repoId, paused);
  }

  clearRepositoryMemories(repoId: string): void {
    this.admin.clearRepository(repoId);
    this.backups.purgeAll();
  }

  createBackup(): string {
    return this.backups.create();
  }

  listMemories(repoId?: string): ListedMemory[] {
    return this.queries.listMemories(repoId);
  }

  listVersions(memoryId: string): ListedVersion[] {
    return this.queries.listVersions(memoryId);
  }

  listPendingReviews(): PendingReview[] {
    return this.queries.listPendingReviews();
  }

  healthSummary(): Record<string, unknown> {
    return this.queries.health();
  }

  sourceStatus(nativeSessionRef: string) {
    return this.queries.sourceStatus(nativeSessionRef);
  }
}

export type {
  AppliedCandidate,
  BoundSession,
  ClaimedJob,
  EnqueuedJob,
  ListedMemory,
  ListedRepository,
  ListedVersion,
  PendingReview,
} from "./types.js";
