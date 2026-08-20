import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { runHook } from "../../src/hooks/runner.js";
import { SidecarService } from "../../src/sidecar/service.js";
import { SidecarSocketServer } from "../../src/sidecar/socket-server.js";
import { applyCreate } from "../helpers/apply-memory.js";

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
    applyCreate(database, session, "turn-create", {
      kind: "lesson",
      title: "请求超时",
      knowledge: "网络请求使用 30s timeout。",
      rationale: "该仓库的默认超时不适用于相关请求。",
      applicability: "HTTP 请求",
    });

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
    assert.doesNotMatch(String(hookOutput.additionalContext), /rationale/u);
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

test("SessionStart compact schedules Gate for pending turn references", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-compact-hook-"));
  const project = join(root, "project");
  const data = join(root, "data");
  const socket = join(data, "sidecar.sock");
  const transcript = join(root, "rollout-compact-session.jsonl");
  await mkdir(project, { recursive: true });
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
  let wakes = 0;
  const server = new SidecarSocketServer(
    socket,
    new SidecarService(database, {
      allowedTranscriptRoots: [root],
      onJobEnqueued: () => {
        wakes += 1;
      },
    }),
  );
  await server.start();
  try {
    await runHook("session-start", {
      socketPath: socket,
      input: { session_id: "compact-session", cwd: project },
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const session = database.getBoundSession("codex", "compact-session");
    assert.ok(session);
    const queued = database.captureStop(
      session.id,
      session.repoId,
      "compact-turn",
      transcript,
      true,
    );
    assert.ok(queued.jobId);
    await runHook("session-start", {
      socketPath: socket,
      input: { session_id: "compact-session", cwd: project, source: "compact" },
      stdout: () => undefined,
      stderr: () => undefined,
    });
    assert.equal(wakes, 1);
    assert.equal(database.sessionRefines.claimNext()?.reason, "compact");
  } finally {
    await server.stop();
    database.close();
  }
});
