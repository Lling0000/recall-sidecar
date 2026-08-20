import type {
  ConsolidationMemoryRef,
  ConsolidationSuggestion,
} from "../model/consolidation-types.js";
import type { CheckpointTurnSource } from "../model/session-types.js";
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

export interface ClaimedSessionRefineJob {
  jobId: string;
  sessionId: string;
  nativeSessionRef: string;
  repoId: string;
  transcriptPath: string;
  reason: "turn_interval" | "compact";
  attempts: number;
}

export interface SessionRefineBatch {
  job: ClaimedSessionRefineJob;
  turns: Array<
    CheckpointTurnSource & {
      internal_turn_id: string;
      role: "eligible" | "overlap";
    }
  >;
}

export interface AppliedCandidate {
  candidateId: string;
  state: "applied" | "stale";
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
  action: "create" | "update";
  candidateId: string;
  memoryId: string;
  oldVersionId: string | null;
  oldVersion: number | null;
  oldCard: MemoryCard | null;
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

export interface ClaimedConsolidationJob {
  jobId: string;
  repoId: string;
  attempts: number;
}

export interface ConsolidationReviewCard {
  memoryId: string;
  version: number;
  card: MemoryCard;
}

export interface PendingConsolidationReview {
  suggestionId: string;
  kind: "merge" | "conflict";
  repoId: string;
  repoDisplayName: string;
  target: ConsolidationReviewCard;
  related: ConsolidationReviewCard[];
  proposedMemory: MemoryCard | null;
  reason: string;
}

export interface StoredConsolidationSuggestion extends ConsolidationSuggestion {
  related_memories: ConsolidationMemoryRef[];
}
