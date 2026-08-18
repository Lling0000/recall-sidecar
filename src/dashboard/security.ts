import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "clm_session";
const TOKEN_TTL_MS = 60_000;

interface DashboardSession {
  csrf: string;
  createdAt: number;
}

export class DashboardSecurity {
  private readonly bootstrapTokens = new Map<string, number>();
  private readonly sessions = new Map<string, DashboardSession>();

  issueBootstrap(origin: string): string {
    const token = randomBytes(32).toString("base64url");
    this.bootstrapTokens.set(token, Date.now() + TOKEN_TTL_MS);
    this.prune();
    return `${origin}/#${token}`;
  }

  bootstrap(token: string, response: ServerResponse): string | null {
    const expiresAt = this.bootstrapTokens.get(token);
    this.bootstrapTokens.delete(token);
    if (!expiresAt || expiresAt < Date.now()) return null;
    const sessionId = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, { csrf, createdAt: Date.now() });
    response.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
    );
    return csrf;
  }

  authenticate(request: IncomingMessage): DashboardSession | null {
    const cookies = request.headers.cookie?.split(";") ?? [];
    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split("=", 2);
      if (name === COOKIE_NAME && value) return this.sessions.get(value) ?? null;
    }
    return null;
  }

  csrfFor(request: IncomingMessage): string | null {
    return this.authenticate(request)?.csrf ?? null;
  }

  authorizeWrite(request: IncomingMessage, origin: string): boolean {
    const session = this.authenticate(request);
    return (
      session !== null &&
      request.headers.origin === origin &&
      request.headers["content-type"]?.startsWith("application/json") === true &&
      request.headers["x-codex-local-csrf"] === session.csrf
    );
  }

  private prune(): void {
    const timestamp = Date.now();
    for (const [token, expiry] of this.bootstrapTokens) {
      if (expiry < timestamp) this.bootstrapTokens.delete(token);
    }
  }
}
