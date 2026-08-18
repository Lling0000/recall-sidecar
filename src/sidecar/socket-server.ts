import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { parseSidecarRequest } from "./protocol.js";
import type { SidecarService } from "./service.js";

const MAX_REQUEST_BYTES = 256 * 1024;

export class SidecarSocketServer {
  private server: Server | null = null;

  constructor(
    readonly socketPath: string,
    private readonly service: SidecarService,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.socketPath), 0o700);
    await this.prepareSocketPath();

    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (existsSync(this.socketPath) && lstatSync(this.socketPath).isSocket()) {
      unlinkSync(this.socketPath);
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(1_000, () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        handled = true;
        this.respond(socket, { ok: false, error: "request_too_large" });
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void this.handleLine(socket, input.slice(0, newline));
    });
    socket.on("error", () => undefined);
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    try {
      const request = parseSidecarRequest(JSON.parse(line));
      this.respond(socket, await this.service.handle(request));
    } catch (error) {
      this.respond(socket, {
        ok: false,
        error: error instanceof Error ? error.message : "invalid_request",
      });
    }
  }

  private respond(socket: Socket, value: unknown): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
  }

  private async prepareSocketPath(): Promise<void> {
    if (!existsSync(this.socketPath)) return;
    const info = lstatSync(this.socketPath);
    if (!info.isSocket()) throw new Error("socket_path_is_not_socket");
    if (await socketAcceptsConnections(this.socketPath)) {
      throw new Error("sidecar_already_running");
    }
    unlinkSync(this.socketPath);
  }
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
