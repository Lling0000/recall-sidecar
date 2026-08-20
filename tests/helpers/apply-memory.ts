import type { MemoryDatabase } from "../../src/db/database.js";
import type { AppliedCandidate, BoundSession } from "../../src/db/types.js";
import type { MemoryCard } from "../../src/types.js";

export function applyCreate(
  database: MemoryDatabase,
  session: BoundSession,
  turnId: string,
  card: MemoryCard,
  transcriptPath = `/tmp/${turnId}.jsonl`,
): AppliedCandidate {
  return applyEdit(database, session, turnId, transcriptPath, {
    action: "create",
    source_turn_id: turnId,
    target_memory_id: null,
    base_version: null,
    memory: card,
  });
}

export function applyUpdate(
  database: MemoryDatabase,
  session: BoundSession,
  turnId: string,
  memoryId: string,
  baseVersion: number,
  card: MemoryCard,
  transcriptPath = `/tmp/${turnId}.jsonl`,
): AppliedCandidate {
  return applyEdit(database, session, turnId, transcriptPath, {
    action: "update",
    source_turn_id: turnId,
    target_memory_id: memoryId,
    base_version: baseVersion,
    memory: card,
  });
}

export function captureTurn(
  database: MemoryDatabase,
  session: BoundSession,
  turnId: string,
  transcriptPath = `/tmp/${turnId}.jsonl`,
) {
  return database.captureStop(session.id, session.repoId, turnId, transcriptPath, true);
}

function applyEdit(
  database: MemoryDatabase,
  session: BoundSession,
  turnId: string,
  transcriptPath: string,
  edit: Parameters<MemoryDatabase["applySessionRefinement"]>[2][number],
): AppliedCandidate {
  const captured = captureTurn(database, session, turnId, transcriptPath);
  if (!captured.jobId) throw new Error("test_capture_job_missing");
  const result = database.applySessionRefinement(
    session.repoId,
    session.id,
    [edit],
    [{ job_id: captured.jobId, turn_id: turnId }],
  )[0];
  if (!result) throw new Error("test_apply_result_missing");
  return result;
}
