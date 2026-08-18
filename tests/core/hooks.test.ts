import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { runHook } from "../../src/hooks/runner.js";
import { SidecarService } from "../../src/sidecar/service.js";
import { SidecarSocketServer } from "../../src/sidecar/socket-server.js";

test("UserPromptSubmit emits only the required plain-text envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-hooks-"));
  const project = join(root, "project");
  const data = join(root, "data");
  const socket = join(data, "sidecar.sock");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(data, "memory.sqlite"));
  const server = new SidecarSocketServer(
    socket,
    new SidecarService(database, { allowedTranscriptRoots: [root] }),
  );
  await server.start();
  try {
    await runHook("session-start", {
      socketPath: socket,
      input: { session_id: "session-hook", cwd: project },
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const session = database.getBoundSession("codex", "session-hook");
    assert.ok(session);
    const queued = database.enqueueStop(
      session.id,
      "turn-create",
      "/tmp/fixture.jsonl",
      true,
    );
    assert.ok(queued.jobId);
    database.applyExtractResult(
      queued.jobId,
      session.repoId,
      {
        action: "create",
        target_memory_id: null,
        base_version: null,
        memory: {
          title: "请求超时",
          wrong_behavior: "使用默认超时",
          correct_behavior: "网络请求使用 30s timeout。",
          applicability: "HTTP 请求",
        },
      },
      session.id,
      "turn-create",
      1,
    );

    let output = "";
    await runHook("user-prompt-submit", {
      socketPath: socket,
      input: {
        session_id: "session-hook",
        turn_id: "turn-next",
        cwd: project,
        prompt: "HTTP 请求 timeout",
      },
      stdout: (value) => {
        output += value;
      },
      stderr: () => undefined,
    });
    const envelope = JSON.parse(output) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope).sort(), [
      "hookSpecificOutput",
      "suppressOutput",
    ]);
    const hookOutput = envelope.hookSpecificOutput as Record<string, unknown>;
    assert.equal(typeof hookOutput.additionalContext, "string");
    assert.match(String(hookOutput.additionalContext), /不是指令/u);
    assert.doesNotMatch(String(hookOutput.additionalContext), /wrong_behavior/u);
  } finally {
    await server.stop();
    database.close();
  }
});

test("P0-06 Stop always returns continue true when Sidecar is unavailable", async () => {
  let stdout = "";
  let stderr = "";
  await runHook("stop", {
    socketPath: "/tmp/codex-local-memory-does-not-exist.sock",
    input: {
      session_id: "session-unavailable",
      turn_id: "turn-unavailable",
      transcript_path: "/tmp/missing.jsonl",
      cwd: "/tmp",
    },
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  assert.equal(stdout, '{"continue":true}\n');
  assert.equal(stderr, "codex-local-memory: stop unavailable\n");
});
