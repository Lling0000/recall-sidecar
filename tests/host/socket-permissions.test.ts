import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { SidecarService } from "../../src/sidecar/service.js";
import { SidecarSocketServer } from "../../src/sidecar/socket-server.js";

test(
  "macOS host creates private SQLite and Unix socket permissions",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "clm-host-socket-"));
    const data = join(root, "data");
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    const databasePath = join(data, "memory.sqlite");
    const socketPath = join(data, "sidecar.sock");
    const database = new MemoryDatabase(databasePath);
    const server = new SidecarSocketServer(
      socketPath,
      new SidecarService(database, { allowedTranscriptRoots: [sessions] }),
    );
    await server.start();
    try {
      assert.equal((await stat(data)).mode & 0o777, 0o700);
      assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
      const socket = await stat(socketPath);
      assert.equal(socket.isSocket(), true);
      assert.equal(socket.mode & 0o777, 0o600);
    } finally {
      await server.stop();
      database.close();
    }
  },
);
