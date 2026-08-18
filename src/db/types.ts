import type { MemoryCard, RepoIdentity } from "../types.js";

export interface RepositoryRow {
  id: string;
  kind: "git" | "folder";
  identity_fingerprint: string;
  common_dir_path: string | null;
  root_path: string | null;
  display_name: string;
  last_seen_path: string;
  remote_label: string | null;
  recall_generation: number;
  remote_warning: number;
}

export interface BoundSession {
  id: string;
  client: string;
  nativeSessionRef: string;
  repoId: string;
  identity: RepoIdentity;
}

export interface EnqueuedJob {
  turnId: string;
  jobId: string | null;
  duplicate: boolean;
}

export interface ClaimedJob {
  jobId: string;
  turnId: string;
  nativeTurnRef: string;
  repoId: string;
  sessionId: string;
  nativeSessionRef: string;
  transcriptPath: string;
  attempts: number;
}

export interface AppliedCandidate {
  candidateId: string;
  state: "applied" | "skipped" | "stale";
  memoryId: string | null;
  version: number | null;
}

export interface ListedMemory {
  id: string;
  repoId: string;
  repoDisplayName: string;
  repoPath: string;
  state: string;
  activeVersion: number;
  activeVersionId: string;
  card: MemoryCard;
  sourceSessionRef: string | null;
  sourceTurnRef: string | null;
  updatedAt: string;
}

export interface PendingReview {
  candidateId: string;
  memoryId: string;
  oldVersionId: string;
  oldVersion: number;
  oldCard: MemoryCard;
  newVersionId: string;
  newVersion: number;
  newCard: MemoryCard;
  sourceSessionRef: string | null;
  sourceTurnRef: string | null;
}

export interface ListedVersion {
  id: string;
  version: number;
  card: MemoryCard;
  restoresVersionId: string | null;
  createdAt: string;
}

export interface ListedRepository {
  id: string;
  kind: "git" | "folder";
  displayName: string;
  path: string;
  memoryCount: number;
  paused: boolean;
}
