import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { callSidecar } from "../../src/hooks/ipc-client.js";
import { SidecarService } from "../../src/sidecar/service.js";
import { SidecarSocketServer } from "../../src/sidecar/socket-server.js";

test("Unix socket binds sessions and enqueues one idempotent Stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-sidecar-"));
  const project = join(root, "project");
  const transcripts = join(root, "sessions");
  const data = join(root, "data");
  const socket = join(data, "sidecar.sock");
  const transcript = join(transcripts, "rollout-session-1.jsonl");
  await mkdir(project, { recursive: true });
  await mkdir(transcripts, { recursive: true });
  await writeFile(transcript, "{}\n");
  const database = new MemoryDatabase(join(data, "memory.sqlite"));
  for (const key of [
    "strict_schema_verified",
    "prompt_consent",
    "final_answer_consent",
    "auto_extract",
  ]) {
    database.setSetting(key, "true");
  }
  const service = new SidecarService(database, {
    allowedTranscriptRoots: [transcripts],
  });
  const server = new SidecarSocketServer(socket, service);
  await server.start();
  try {
    const started = await callSidecar(
      socket,
      {
        type: "session_start",
        client: "codex",
        session_id: "session-1",
        cwd: project,
      },
      1_000,
    );
    assert.equal(started.ok, true);
    const mode = (await stat(socket)).mode & 0o777;
    assert.equal(mode, 0o600);

    const stopRequest = {
      type: "stop" as const,
      client: "codex" as const,
      session_id: "session-1",
      turn_id: "turn-1",
      transcript_path: transcript,
      cwd: project,
    };
    const first = await callSidecar(socket, stopRequest, 1_000);
    const duplicate = await callSidecar(socket, stopRequest, 1_000);
    assert.deepEqual(first, { ok: true, enqueued: true });
    assert.deepEqual(duplicate, { ok: true, enqueued: true });
    const bound = database.getBoundSession("codex", "session-1");
    assert.ok(bound);
    assert.equal(database.sessionRefines.pendingCount(bound.id), 1);
  } finally {
    await server.stop();
    database.close();
  }
});

test("P0-19 cross-repo cwd is an empty operation and never rebinds the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-sidecar-"));
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  const data = join(root, "data");
  const socket = join(data, "sidecar.sock");
  await mkdir(firstProject, { recursive: true });
  await mkdir(secondProject, { recursive: true });
  const database = new MemoryDatabase(join(data, "memory.sqlite"));
  const server = new SidecarSocketServer(
    socket,
    new SidecarService(database, { allowedTranscriptRoots: [root] }),
  );
  await server.start();
  try {
    await callSidecar(
      socket,
      {
        type: "session_start",
        client: "codex",
        session_id: "sticky-session",
        cwd: firstProject,
      },
      1_000,
    );
    const original = database.getBoundSession("codex", "sticky-session");
    const response = await callSidecar(
      socket,
      {
        type: "recall",
        client: "codex",
        session_id: "sticky-session",
        turn_id: "turn-cross-repo",
        cwd: secondProject,
        prompt: "timeout",
      },
      1_000,
    );
    assert.deepEqual(response, { ok: true });
    assert.equal(
      database.getBoundSession("codex", "sticky-session")?.repoId,
      original?.repoId,
    );
  } finally {
    await server.stop();
    database.close();
  }
});
