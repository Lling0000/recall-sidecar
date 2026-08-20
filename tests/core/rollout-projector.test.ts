import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProjectionError,
  projectRollout,
  projectRollouts,
} from "../../src/rollout/projector.js";

const FIXTURE = new URL("../fixtures/rollout-0.148.0-alpha.9.jsonl", import.meta.url);
const SUBAGENT_FIXTURE = new URL(
  "../fixtures/rollout-subagent-0.148.0-alpha.9.jsonl",
  import.meta.url,
);

test("projects only the exact completed target turn", async () => {
  const projection = await projectRollout(
    FIXTURE.pathname,
    "session-user-1",
    "turn-target",
  );

  assert.equal(projection.cliVersion, "0.148.0-alpha.9");
  assert.equal(projection.userPrompt, "下次 timeout 用 30s");
  assert.equal(projection.finalAnswer, "以后会把 timeout 设为 30s。");
  assert.equal(projection.previousUserPrompt, "把重试次数改成两次");
  assert.match(projection.sourceDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(projection), /不得读取或投影/);
  assert.doesNotMatch(JSON.stringify(projection), /last_agent_message/);
});

test("projects a checkpoint batch in one rollout pass", async () => {
  const projections = await projectRollouts(FIXTURE.pathname, "session-user-1", [
    "turn-previous",
    "turn-target",
  ]);
  assert.deepEqual(
    projections.map((projection) => projection.turnId),
    ["turn-previous", "turn-target"],
  );
  assert.equal(projections[0]?.userPrompt, "把重试次数改成两次");
  assert.equal(projections[1]?.previousUserPrompt, "把重试次数改成两次");
});

test("rejects subagent rollouts before extraction", async () => {
  await assert.rejects(
    projectRollout(SUBAGENT_FIXTURE.pathname, "session-subagent-1", "turn-subagent"),
    (error: unknown) => error instanceof ProjectionError && error.code === "subagent",
  );
});

test("P0-22 accepts a new CLI version when the rollout shape is compatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clm-rollout-"));
  const target = join(directory, "rollout.jsonl");
  const fixture = await readFile(FIXTURE, "utf8");
  await writeFile(target, fixture.replace("0.148.0-alpha.9", "0.148.0-alpha.10"));

  const projection = await projectRollout(target, "session-user-1", "turn-target");
  assert.equal(projection.cliVersion, "0.148.0-alpha.10");
});

test("does not fall back to the latest complete turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clm-rollout-"));
  const target = join(directory, "rollout.jsonl");
  await copyFile(FIXTURE, target);

  await assert.rejects(
    projectRollout(target, "session-user-1", "missing-turn"),
    (error: unknown) =>
      error instanceof ProjectionError && error.code === "turn_not_found",
  );
});
