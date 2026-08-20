import { randomUUID } from "node:crypto";
import type { MemoryCard } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { replaceMemoryFts } from "./fts-writer.js";
import { now, row, topicKey } from "./helpers.js";

export function applyConsolidationSplit(
  core: DatabaseCore,
  suggestionId: string,
  repoId: string,
  target: { id: string; version: number; card: MemoryCard },
  proposed: readonly MemoryCard[],
  relatedCount: number,
): "applied" | "stale" {
  if (
    !validShape(target.card, proposed, relatedCount) ||
    hasTopicCollision(core, repoId, target.id, proposed)
  ) {
    markStale(core, suggestionId);
    return "stale";
  }
  const timestamp = now();
  const primary = proposed[0];
  if (!primary) {
    markStale(core, suggestionId);
    return "stale";
  }
  const versionId = randomUUID();
  const version = target.version + 1;
  core.db
    .prepare(
      `INSERT INTO memory_versions(id,memory_id,version_no,content,created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(versionId, target.id, version, JSON.stringify(primary), timestamp);
  core.db
    .prepare(
      `UPDATE memories SET active_version_id=?,topic_key=?,updated_at=?
       WHERE id=? AND state='active'`,
    )
    .run(versionId, topicKey(primary.title), timestamp, target.id);
  replaceMemoryFts(core, target.id, repoId, primary);

  const createdMemoryIds = proposed
    .slice(1)
    .map((card) => createSplitMemory(core, repoId, card, timestamp));
  core.db
    .prepare(
      "UPDATE knowledge_consolidation_suggestions SET state='applied',updated_at=? WHERE id=?",
    )
    .run(timestamp, suggestionId);
  core.bumpGeneration(repoId);
  core.audit("knowledge_consolidation_split_applied", suggestionId, {
    repo_id: repoId,
    target_memory_id: target.id,
    created_memory_ids: createdMemoryIds,
    version,
  });
  return "applied";
}

function createSplitMemory(
  core: DatabaseCore,
  repoId: string,
  card: MemoryCard,
  timestamp: string,
): string {
  const memoryId = randomUUID();
  const versionId = randomUUID();
  core.db
    .prepare(
      `INSERT INTO memories(
        id,repo_id,active_version_id,topic_key,state,created_at,updated_at
      ) VALUES (?,?,NULL,?,'active',?,?)`,
    )
    .run(memoryId, repoId, topicKey(card.title), timestamp, timestamp);
  core.db
    .prepare(
      `INSERT INTO memory_versions(id,memory_id,version_no,content,created_at)
       VALUES (?,?,1,?,?)`,
    )
    .run(versionId, memoryId, JSON.stringify(card), timestamp);
  core.db
    .prepare("UPDATE memories SET active_version_id=? WHERE id=?")
    .run(versionId, memoryId);
  replaceMemoryFts(core, memoryId, repoId, card);
  return memoryId;
}

function validShape(
  target: MemoryCard,
  proposed: readonly MemoryCard[],
  relatedCount: number,
): boolean {
  return (
    relatedCount === 0 &&
    proposed.length >= 2 &&
    proposed.length <= 8 &&
    proposed.every((memory) => memory.kind === target.kind)
  );
}

function hasTopicCollision(
  core: DatabaseCore,
  repoId: string,
  targetId: string,
  proposed: readonly MemoryCard[],
): boolean {
  const keys = proposed.map((card) => topicKey(card.title));
  if (new Set(keys).size !== keys.length) return true;
  const placeholders = keys.map(() => "?").join(",");
  return Boolean(
    row<{ id: string }>(
      core.db
        .prepare(
          `SELECT id FROM memories WHERE repo_id=? AND state='active'
           AND id!=? AND topic_key IN (${placeholders}) LIMIT 1`,
        )
        .get(repoId, targetId, ...keys),
    ),
  );
}

function markStale(core: DatabaseCore, suggestionId: string): void {
  core.db
    .prepare(
      "UPDATE knowledge_consolidation_suggestions SET state='stale',updated_at=? WHERE id=?",
    )
    .run(now(), suggestionId);
}
