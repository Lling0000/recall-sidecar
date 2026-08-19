import type {
  SessionRefinerEdit,
  StagedTurnCandidate,
} from "../model/session-types.js";
import type { AppliedCandidate } from "./types.js";

interface SessionApplyHandlers {
  transaction<T>(operation: () => T): T;
  existing(jobId: string): AppliedCandidate | null;
  updateIsCurrent(edit: SessionRefinerEdit): boolean;
  create(source: StagedTurnCandidate, edit: SessionRefinerEdit): AppliedCandidate;
  update(source: StagedTurnCandidate, edit: SessionRefinerEdit): AppliedCandidate;
}

export function applySessionEdits(
  edits: readonly SessionRefinerEdit[],
  candidates: readonly StagedTurnCandidate[],
  handlers: SessionApplyHandlers,
): AppliedCandidate[] {
  return handlers.transaction(() => {
    const candidateByTurn = new Map(candidates.map((value) => [value.turn_id, value]));
    const existingByTurn = new Map<string, AppliedCandidate>();
    const usedTurns = new Set<string>();
    for (const edit of edits) {
      const source = candidateByTurn.get(edit.source_turn_id);
      if (!source || usedTurns.has(edit.source_turn_id)) {
        throw new Error("session_refine_source_turn_invalid");
      }
      usedTurns.add(edit.source_turn_id);
      const existing = handlers.existing(source.job_id);
      if (existing) {
        existingByTurn.set(edit.source_turn_id, existing);
        continue;
      }
      if (edit.action === "update" && !handlers.updateIsCurrent(edit)) {
        throw new Error("session_refine_stale");
      }
    }

    return edits.map((edit) => {
      const existing = existingByTurn.get(edit.source_turn_id);
      if (existing) return existing;
      const source = candidateByTurn.get(edit.source_turn_id);
      if (!source) throw new Error("session_refine_source_turn_invalid");
      return edit.action === "create"
        ? handlers.create(source, edit)
        : handlers.update(source, edit);
    });
  });
}
