import { dirname, join } from "node:path";
import type {
  CheckpointTurnSource,
  SessionRefinerEdit,
} from "../model/session-types.js";
import type { RepoIdentity } from "../types.js";
import { BackupStore } from "./backup-store.js";
import { KnowledgeConsolidationAdmin } from "./consolidation-admin.js";
import { KnowledgeConsolidationStore } from "./consolidation-store.js";
import { DatabaseCore } from "./core.js";
import { JobStore } from "./job-store.js";
import { MemoryAdminStore } from "./memory-admin.js";
import { MemoryApplyStore } from "./memory-apply.js";
import { MemoryQueryStore } from "./memory-query.js";
import { ModelSettingsStore } from "./model-settings.js";
import { RepositoryStore } from "./repository-store.js";
import { SessionRefineStore } from "./session-refine-store.js";
import type {
  AppliedCandidate,
  BoundSession,
  EnqueuedJob,
  ListedMemory,
  ListedRepository,
  ListedVersion,
  PendingConsolidationReview,
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
  readonly sessionRefines: SessionRefineStore;
  readonly consolidations: KnowledgeConsolidationStore;
  readonly modelSettings: ModelSettingsStore;
  private readonly consolidationAdmin: KnowledgeConsolidationAdmin;
  private readonly backups: BackupStore;

  constructor(path: string) {
    this.core = new DatabaseCore(path);
    this.repositories = new RepositoryStore(this.core);
    this.jobs = new JobStore(this.core);
    this.queries = new MemoryQueryStore(this.core);
    this.applyStore = new MemoryApplyStore(this.core, this.jobs);
    this.admin = new MemoryAdminStore(this.core);
    this.sessionRefines = new SessionRefineStore(this.core);
    this.consolidations = new KnowledgeConsolidationStore(this.core);
    this.consolidationAdmin = new KnowledgeConsolidationAdmin(this.core);
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

  captureStop(
    sessionId: string,
    repoId: string,
    nativeTurnRef: string,
    transcriptPath: string,
    capture: boolean,
  ): EnqueuedJob {
    return this.jobs.captureStop(
      sessionId,
      repoId,
      nativeTurnRef,
      transcriptPath,
      capture,
    );
  }

  searchCards(repoId: string, prompt: string, limit?: number) {
    return this.queries.search(repoId, prompt, limit);
  }

  recall(repoId: string, prompt: string): string {
    return this.queries.recall(repoId, prompt);
  }

  applySessionRefinement(
    repoId: string,
    sessionId: string,
    edits: readonly SessionRefinerEdit[],
    candidates: readonly CheckpointTurnSource[],
  ): AppliedCandidate[] {
    return this.applyStore.applySessionRefinement(repoId, sessionId, edits, candidates);
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

  listPendingConsolidations(): PendingConsolidationReview[] {
    return this.consolidationAdmin.listPending();
  }

  ignoreConsolidation(suggestionId: string): void {
    this.consolidationAdmin.ignore(suggestionId);
  }

  applyConsolidationMerge(suggestionId: string): "applied" | "stale" {
    return this.consolidationAdmin.applyMerge(suggestionId);
  }

  healthSummary(): Record<string, unknown> {
    const consolidation = this.consolidations.health();
    return {
      ...this.queries.health(),
      pending_consolidations: consolidation.pending,
      failed_consolidations: consolidation.failed,
    };
  }

  sourceStatus(nativeSessionRef: string) {
    return this.queries.sourceStatus(nativeSessionRef);
  }
}

export type {
  AppliedCandidate,
  BoundSession,
  EnqueuedJob,
  ListedMemory,
  ListedRepository,
  ListedVersion,
  PendingConsolidationReview,
  PendingReview,
} from "./types.js";
