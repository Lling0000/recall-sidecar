import type {
  CheckpointTurnSource,
  SessionRefinerEdit,
} from "../model/session-types.js";
import type { AppliedCandidate } from "./types.js";

interface SessionApplyHandlers {
  transaction<T>(operation: () => T): T;
  existing(jobId: string, editOrdinal: number): AppliedCandidate | null;
  updateIsCurrent(edit: SessionRefinerEdit): boolean;
  create(
    source: CheckpointTurnSource,
    edit: SessionRefinerEdit,
    editOrdinal: number,
  ): AppliedCandidate;
  update(
    source: CheckpointTurnSource,
    edit: SessionRefinerEdit,
    editOrdinal: number,
  ): AppliedCandidate;
}

export function applySessionEdits(
  edits: readonly SessionRefinerEdit[],
  candidates: readonly CheckpointTurnSource[],
  handlers: SessionApplyHandlers,
): AppliedCandidate[] {
  return handlers.transaction(() => {
    const candidateByTurn = new Map(candidates.map((value) => [value.turn_id, value]));
    const existingByOrdinal = new Map<number, AppliedCandidate>();
    const usedTargets = new Set<string>();
    for (const [editOrdinal, edit] of edits.entries()) {
      const source = candidateByTurn.get(edit.source_turn_id);
      if (!source) {
        throw new Error("session_refine_source_turn_invalid");
      }
      if (edit.action === "update") {
        if (!edit.target_memory_id || usedTargets.has(edit.target_memory_id)) {
          throw new Error("session_refine_target_invalid");
        }
        usedTargets.add(edit.target_memory_id);
      }
      const existing = handlers.existing(source.job_id, editOrdinal);
      if (existing) {
        existingByOrdinal.set(editOrdinal, existing);
        continue;
      }
      if (edit.action === "update" && !handlers.updateIsCurrent(edit)) {
        throw new Error("session_refine_stale");
      }
    }

    return edits.map((edit, editOrdinal) => {
      const existing = existingByOrdinal.get(editOrdinal);
      if (existing) return existing;
      const source = candidateByTurn.get(edit.source_turn_id);
      if (!source) throw new Error("session_refine_source_turn_invalid");
      return edit.action === "create"
        ? handlers.create(source, edit, editOrdinal)
        : handlers.update(source, edit, editOrdinal);
    });
  });
}
