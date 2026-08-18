export type RepoKind = "git" | "folder";

export interface RepoIdentity {
  kind: RepoKind;
  identityFingerprint: string;
  commonDirPath: string | null;
  rootPath: string | null;
  displayName: string;
  lastSeenPath: string;
  remoteLabel: string | null;
  discoveredGitPath: string | null;
}

export interface MemoryCard {
  title: string;
  wrong_behavior: string;
  correct_behavior: string;
  applicability: string;
}

export type ExtractAction = "skip" | "reject" | "create" | "update" | "need_prev_turn";

export interface ExtractResult {
  action: ExtractAction;
  target_memory_id: string | null;
  base_version: number | null;
  memory: MemoryCard | null;
}

export interface CompareCard extends MemoryCard {
  id: string;
  version: number;
}

export interface RolloutProjection {
  cliVersion: string;
  sessionId: string;
  turnId: string;
  userPrompt: string;
  finalAnswer: string;
  previousUserPrompt: string | null;
  projectionVersion: string;
  sourceDigest: string;
}

export interface SessionStartRequest {
  type: "session_start";
  client: "codex";
  session_id: string;
  cwd: string;
  transcript_path?: string;
}

export interface RecallRequest {
  type: "recall";
  client: "codex";
  session_id: string;
  turn_id: string;
  cwd: string;
  prompt: string;
}

export interface StopRequest {
  type: "stop";
  client: "codex";
  session_id: string;
  turn_id: string;
  transcript_path: string;
  cwd: string;
}

export interface DashboardBootstrapRequest {
  type: "dashboard_bootstrap";
}

export type SidecarRequest =
  | SessionStartRequest
  | RecallRequest
  | StopRequest
  | DashboardBootstrapRequest;

export type SidecarResponse =
  | {
      ok: true;
      repo_id?: string;
      additional_context?: string;
      enqueued?: boolean;
      dashboard_url?: string;
    }
  | { ok: false; error: string };
