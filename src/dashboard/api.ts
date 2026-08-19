import type { IncomingMessage, ServerResponse } from "node:http";
import { SUPPORTED_CODEX_CLI_VERSIONS } from "../constants.js";
import type { MemoryDatabase } from "../db/database.js";
import type { ModelManager } from "../model/manager.js";
import { readJsonBody, requiredString, sendJson } from "./http-utils.js";
import type { DashboardSecurity } from "./security.js";

export class DashboardApi {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly models: ModelManager,
    private readonly security: DashboardSecurity,
    private readonly origin: string,
  ) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === "/api/bootstrap" && request.method === "POST") {
      await this.bootstrap(request, response);
      return true;
    }
    if (!url.pathname.startsWith("/api/")) return false;
    if (!this.security.authenticate(request)) {
      sendJson(response, 401, { error: "authentication_required" });
      return true;
    }
    if (
      request.method !== "GET" &&
      !this.security.authorizeWrite(request, this.origin)
    ) {
      sendJson(response, 403, { error: "write_guard_rejected" });
      return true;
    }

    try {
      if (request.method === "GET") {
        return this.handleGet(request, response, url);
      }
      return await this.handleWrite(request, response, url);
    } catch (error) {
      const code = safeErrorCode(error);
      sendJson(response, 400, { error: code });
      return true;
    }
  }

  private async bootstrap(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      request.headers.origin !== this.origin ||
      request.headers["content-type"]?.startsWith("application/json") !== true ||
      request.headers["x-codex-local-bootstrap"] !== "1"
    ) {
      sendJson(response, 403, { error: "bootstrap_guard_rejected" });
      return;
    }
    const body = await readJsonBody(request, 4_096);
    const token = requiredString(body.token, "bootstrap_token", 200);
    const csrf = this.security.bootstrap(token, response);
    if (!csrf) {
      sendJson(response, 401, { error: "invalid_bootstrap_token" });
      return;
    }
    sendJson(response, 200, { csrf });
  }

  private handleGet(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): boolean {
    if (url.pathname === "/api/session") {
      sendJson(response, 200, { csrf: this.security.csrfFor(request) });
      return true;
    }
    if (url.pathname === "/api/reviews") {
      sendJson(response, 200, { reviews: this.database.listPendingReviews() });
      return true;
    }
    if (url.pathname === "/api/repositories") {
      sendJson(response, 200, {
        repositories: this.database.listRepositories(),
      });
      return true;
    }
    if (url.pathname === "/api/memories") {
      const repo = url.searchParams.get("repo") ?? undefined;
      const query = url.searchParams.get("q")?.toLocaleLowerCase() ?? "";
      const memories = this.database
        .listMemories(repo)
        .filter((memory) =>
          query
            ? JSON.stringify(memory.card).toLocaleLowerCase().includes(query)
            : true,
        )
        .map((memory) => ({
          ...memory,
          source: memory.sourceSessionRef
            ? this.database.sourceStatus(memory.sourceSessionRef)
            : { command: null, available: false },
        }));
      sendJson(response, 200, { memories });
      return true;
    }
    const versions = url.pathname.match(/^\/api\/memories\/([^/]+)\/versions$/u);
    if (versions?.[1]) {
      sendJson(response, 200, {
        versions: this.database.listVersions(decodeURIComponent(versions[1])),
      });
      return true;
    }
    if (url.pathname === "/api/model") {
      const configuration = this.database.modelSettings.getConfiguration();
      sendJson(response, 200, {
        configuration,
        strict_schema_verified:
          this.database.getSetting("strict_schema_verified") === "true",
        auto_extract: this.database.extractionEnabled(),
        last_error: this.database.getSetting("model_last_error") || null,
      });
      return true;
    }
    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        sidecar: "ok",
        hooks: ["SessionStart", "UserPromptSubmit", "Stop"],
        cli_fixture_whitelist: SUPPORTED_CODEX_CLI_VERSIONS,
        ...this.database.healthSummary(),
      });
      return true;
    }
    return false;
  }

  private async handleWrite(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const review = url.pathname.match(/^\/api\/reviews\/([^/]+)\/confirm$/u);
    if (request.method === "POST" && review?.[1]) {
      this.database.confirmCandidate(decodeURIComponent(review[1]));
      sendJson(response, 200, { ok: true });
      return true;
    }
    const repositoryAction = url.pathname.match(
      /^\/api\/repositories\/([^/]+)\/(pause|memories)$/u,
    );
    if (repositoryAction?.[1] && repositoryAction[2]) {
      const repoId = decodeURIComponent(repositoryAction[1]);
      const body = await readJsonBody(request);
      if (request.method === "POST" && repositoryAction[2] === "pause") {
        if (typeof body.paused !== "boolean") throw new Error("invalid_paused");
        this.database.setRepositoryPaused(repoId, body.paused);
        sendJson(response, 200, { ok: true });
        return true;
      }
      if (request.method === "DELETE" && repositoryAction[2] === "memories") {
        if (body.confirm_repo_id !== repoId) {
          throw new Error("clear_confirmation_required");
        }
        this.database.clearRepositoryMemories(repoId);
        sendJson(response, 200, { ok: true });
        return true;
      }
    }
    const memoryAction = url.pathname.match(
      /^\/api\/memories\/([^/]+)\/(rollback|archive)$/u,
    );
    if (request.method === "POST" && memoryAction?.[1] && memoryAction[2]) {
      const memoryId = decodeURIComponent(memoryAction[1]);
      if (memoryAction[2] === "archive") this.database.archiveMemory(memoryId);
      else {
        const body = await readJsonBody(request);
        this.database.rollbackMemory(
          memoryId,
          requiredString(body.version_id, "version_id", 200),
        );
      }
      sendJson(response, 200, { ok: true });
      return true;
    }
    const deletion = url.pathname.match(/^\/api\/memories\/([^/]+)$/u);
    if (request.method === "DELETE" && deletion?.[1]) {
      const memoryId = decodeURIComponent(deletion[1]);
      const body = await readJsonBody(request);
      if (body.confirm_memory_id !== memoryId)
        throw new Error("delete_confirmation_required");
      this.database.hardDeleteMemory(memoryId);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (url.pathname === "/api/model/configure" && request.method === "POST") {
      const body = await readJsonBody(request);
      const apiKey =
        body.api_key === undefined || body.api_key === ""
          ? null
          : requiredString(body.api_key, "api_key", 20_000);
      const model = requiredString(body.model, "model", 200);
      const refinerModel =
        body.refiner_model === undefined
          ? model
          : requiredString(body.refiner_model, "refiner_model", 200);
      await this.models.configure(
        requiredString(body.base_url, "base_url", 2_000),
        model,
        apiKey,
        refinerModel,
      );
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (url.pathname === "/api/model/test" && request.method === "POST") {
      const result = await this.models.testConnection();
      sendJson(response, 200, {
        ok: true,
        attempts: result.attempts,
        request_preview: result.requestPreview,
      });
      return true;
    }
    if (url.pathname === "/api/model/enable" && request.method === "POST") {
      await readJsonBody(request);
      this.models.enable();
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (url.pathname === "/api/model/pause" && request.method === "POST") {
      this.models.pause();
      sendJson(response, 200, { ok: true });
      return true;
    }
    return false;
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  return "request_failed";
}
