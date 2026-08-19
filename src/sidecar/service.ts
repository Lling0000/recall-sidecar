import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryDatabase } from "../db/database.js";
import { cwdMatchesBoundIdentity, resolveRepoIdentity } from "../repo/identity.js";
import type { SidecarRequest, SidecarResponse } from "../types.js";
import { validateTranscriptPath } from "./transcript-path.js";

export interface SidecarServiceOptions {
  allowedTranscriptRoots?: readonly string[];
  onJobEnqueued?: () => void;
  issueDashboardBootstrap?: () => string;
}

export class SidecarService {
  private readonly allowedTranscriptRoots: readonly string[];
  private readonly onJobEnqueued: () => void;
  private readonly issueDashboardBootstrap: () => string;

  constructor(
    readonly database: MemoryDatabase,
    options: SidecarServiceOptions = {},
  ) {
    this.allowedTranscriptRoots = options.allowedTranscriptRoots ?? [
      join(homedir(), ".codex", "sessions"),
    ];
    this.onJobEnqueued = options.onJobEnqueued ?? (() => undefined);
    this.issueDashboardBootstrap =
      options.issueDashboardBootstrap ??
      (() => {
        throw new Error("dashboard_not_running");
      });
  }

  async handle(request: SidecarRequest): Promise<SidecarResponse> {
    try {
      if (request.type === "dashboard_bootstrap") {
        return { ok: true, dashboard_url: this.issueDashboardBootstrap() };
      }
      if (request.type === "session_start") {
        const identity = await resolveRepoIdentity(request.cwd);
        const session = this.database.bindSession(
          request.client,
          request.session_id,
          identity,
          request.transcript_path ?? null,
        );
        if (
          request.source === "compact" &&
          this.database.extractionEnabled() &&
          !this.database.repositoryPaused(session.repoId)
        ) {
          const jobId = this.database.sessionRefines.enqueue(
            session.id,
            session.repoId,
            "compact",
          );
          if (jobId) this.onJobEnqueued();
        }
        return { ok: true, repo_id: session.repoId };
      }

      const session = this.database.getBoundSession(request.client, request.session_id);
      if (!session) return { ok: false, error: "session_not_bound" };
      if (!(await cwdMatchesBoundIdentity(session.identity, request.cwd))) {
        return { ok: true };
      }

      if (request.type === "recall") {
        return {
          ok: true,
          additional_context: this.database.recall(session.repoId, request.prompt),
        };
      }

      const transcriptPath = await validateTranscriptPath(
        request.transcript_path,
        request.session_id,
        this.allowedTranscriptRoots,
      );
      const queued = this.database.enqueueStop(
        session.id,
        request.turn_id,
        transcriptPath,
        this.database.extractionEnabled() &&
          !this.database.repositoryPaused(session.repoId),
      );
      if (queued.jobId) this.onJobEnqueued();
      return { ok: true, enqueued: queued.jobId !== null };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "sidecar_failure",
      };
    }
  }
}
