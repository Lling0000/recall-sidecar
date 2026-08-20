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

export type MemoryKind = "decision" | "invariant" | "pitfall" | "lesson";

export interface MemoryCard {
  kind: MemoryKind;
  title: string;
  knowledge: string;
  rationale: string;
  applicability: string;
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
  source?: "startup" | "resume" | "clear" | "compact";
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
