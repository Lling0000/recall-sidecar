import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../../src/db/database.js";
import { resolveRepoIdentity } from "../../src/repo/identity.js";
import type { MemoryCard } from "../../src/types.js";
import { applyCreate, captureTurn } from "../helpers/apply-memory.js";

const CARD: MemoryCard = {
  kind: "lesson",
  title: "提交检查",
  knowledge: "提交前运行 make lint。",
  rationale: "该仓库的提交检查依赖 lint 结果。",
  applicability: "本地提交与 PR",
};

async function gitProject(path: string, remote: string): Promise<void> {
  await mkdir(join(path, ".git"), { recursive: true });
  await writeFile(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(path, ".git", "config"),
    `[remote "origin"]\n  url = ${remote}\n`,
  );
}

test("P0-10 changing remote keeps repo_id and records a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-remote-"));
  const project = join(root, "project");
  await gitProject(project, "ssh://example.test/original.git");
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  try {
    const first = database.bindSession(
      "codex",
      "remote-session-1",
      await resolveRepoIdentity(project),
    );
    await writeFile(
      join(project, ".git", "config"),
      '[remote "origin"]\n  url = ssh://evil.example/impostor.git\n',
    );
    const second = database.bindSession(
      "codex",
      "remote-session-2",
      await resolveRepoIdentity(project),
    );
    assert.equal(first.repoId, second.repoId);
    assert.equal(database.healthSummary().remote_warnings, 1);
  } finally {
    database.close();
  }
});

test("P0-21 source command degrades safely after Codex transcript deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-source-"));
  const project = join(root, "project");
  const transcript = join(root, "rollout-source-session.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(transcript, "{}\n");
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  try {
    const session = database.bindSession(
      "codex",
      "source-session",
      await resolveRepoIdentity(project),
    );
    applyCreate(database, session, "source-turn", CARD, transcript);
    assert.deepEqual(database.sourceStatus("source-session"), {
      command: "codex resume source-session",
      available: true,
    });
    await rm(transcript);
    assert.deepEqual(database.sourceStatus("source-session"), {
      command: "codex resume source-session",
      available: false,
    });
    assert.match(database.recall(session.repoId, "提交 lint"), /make lint/u);
  } finally {
    database.close();
  }
});

test("P0-24 recall is empty before Apply and active immediately after commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-visibility-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  try {
    const session = database.bindSession(
      "codex",
      "visibility-session",
      await resolveRepoIdentity(project),
    );
    const queued = captureTurn(database, session, "visibility-turn");
    assert.ok(queued.jobId);
    assert.equal(database.recall(session.repoId, "提交 lint"), "");
    database.applySessionRefinement(
      session.repoId,
      session.id,
      [
        {
          action: "create",
          source_turn_id: "visibility-turn",
          target_memory_id: null,
          base_version: null,
          memory: CARD,
        },
      ],
      [{ job_id: queued.jobId, turn_id: "visibility-turn" }],
    );
    assert.match(database.recall(session.repoId, "提交 lint"), /make lint/u);
  } finally {
    database.close();
  }
});
