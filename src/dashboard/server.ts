import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_HOST, DASHBOARD_PORT } from "../constants.js";
import type { MemoryDatabase } from "../db/database.js";
import type { ModelManager } from "../model/manager.js";
import { DashboardApi } from "./api.js";
import { sendJson, sendText } from "./http-utils.js";
import { DashboardSecurity } from "./security.js";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

interface Assets {
  html: string;
  javascript: string;
  reviewsJavascript: string;
  bootstrapJavascript: string;
  css: string;
  iconCss: string;
  iconFont: Buffer;
}

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  assetsDirectory?: string;
}

export class DashboardServer {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  private readonly security = new DashboardSecurity();
  private readonly api: DashboardApi;
  private readonly assetsDirectory: string;
  private assets: Assets | null = null;
  private server: Server | null = null;

  constructor(
    database: MemoryDatabase,
    models: ModelManager,
    options: DashboardServerOptions = {},
  ) {
    this.host = options.host ?? DASHBOARD_HOST;
    this.port = options.port ?? DASHBOARD_PORT;
    if (this.host !== DASHBOARD_HOST) throw new Error("dashboard_must_bind_loopback");
    this.origin = `http://${this.host}:${this.port}`;
    this.assetsDirectory = options.assetsDirectory ?? dashboardAssetsDirectory();
    this.api = new DashboardApi(database, models, this.security, this.origin);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.assets = await loadAssets(this.assetsDirectory);
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  issueBootstrapUrl(): string {
    if (!this.server) throw new Error("dashboard_not_running");
    return this.security.issueBootstrap(this.origin);
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(response);
    if (
      request.headers.host !== `${this.host}:${this.port}` ||
      !isLoopbackAddress(request.socket.remoteAddress)
    ) {
      sendJson(response, 403, { error: "host_rejected" });
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", this.origin);
    } catch {
      sendJson(response, 400, { error: "invalid_url" });
      return;
    }
    try {
      if (await this.api.handle(request, response, url)) return;
      if (request.method !== "GET" || !this.assets) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (url.pathname === "/") {
        sendText(response, 200, "text/html; charset=utf-8", this.assets.html);
      } else if (url.pathname === "/app.js") {
        sendText(
          response,
          200,
          "text/javascript; charset=utf-8",
          this.assets.javascript,
        );
      } else if (url.pathname === "/reviews.js") {
        sendText(
          response,
          200,
          "text/javascript; charset=utf-8",
          this.assets.reviewsJavascript,
        );
      } else if (url.pathname === "/bootstrap.js") {
        sendText(
          response,
          200,
          "text/javascript; charset=utf-8",
          this.assets.bootstrapJavascript,
        );
      } else if (url.pathname === "/app.css") {
        sendText(response, 200, "text/css; charset=utf-8", this.assets.css);
      } else if (url.pathname === "/icons.css") {
        sendText(response, 200, "text/css; charset=utf-8", this.assets.iconCss);
      } else if (url.pathname === "/Phosphor-Thin.woff2") {
        response.statusCode = 200;
        response.setHeader("content-type", "font/woff2");
        response.end(this.assets.iconFont);
      } else {
        sendJson(response, 404, { error: "not_found" });
      }
    } catch {
      sendJson(response, 500, { error: "dashboard_failure" });
    }
  }
}

export function dashboardAssetsDirectory(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL("../assets/dashboard", moduleUrl));
}

async function loadAssets(directory: string): Promise<Assets> {
  const [
    html,
    javascript,
    reviewsJavascript,
    bootstrapJavascript,
    css,
    iconCss,
    iconFont,
  ] = await Promise.all([
    readFile(join(directory, "index.html"), "utf8"),
    readFile(join(directory, "app.js"), "utf8"),
    readFile(join(directory, "reviews.js"), "utf8"),
    readFile(join(directory, "bootstrap.js"), "utf8"),
    readFile(join(directory, "app.css"), "utf8"),
    readFile(join(directory, "icons.css"), "utf8"),
    readFile(join(directory, "Phosphor-Thin.woff2")),
  ]);
  return {
    html,
    javascript,
    reviewsJavascript,
    bootstrapJavascript,
    css,
    iconCss,
    iconFont,
  };
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", CSP);
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
