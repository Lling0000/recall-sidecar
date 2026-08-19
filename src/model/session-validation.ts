import { validateMemoryCard } from "../security/memory-card.js";
import { redactSecrets } from "../security/redact.js";
import type { MemoryCard } from "../types.js";
import { ModelError } from "./client.js";
import { MAX_REFINER_EDITS } from "./session-contract.js";
import type {
  SessionGateInput,
  SessionGateResult,
  SessionRefinerEdit,
  SessionRefinerInput,
  SessionRefinerResult,
  StagedTurnCandidate,
} from "./session-types.js";

export function prepareSessionInput<T extends SessionGateInput>(
  input: T,
  maxChars: number,
): T {
  const prepared = redactInput(input);
  while (JSON.stringify(prepared).length > maxChars && prepared.turns.length > 1) {
    const removed = prepared.turns.shift();
    if (removed) {
      prepared.candidates = prepared.candidates.filter(
        (candidate) => candidate.turn_id !== removed.turn_id,
      );
    }
  }
  while (
    JSON.stringify(prepared).length > maxChars &&
    prepared.active_memories.length > 0
  ) {
    prepared.active_memories.pop();
  }
  if (JSON.stringify(prepared).length > maxChars) {
    throw new ModelError("model_input_too_large");
  }
  return prepared;
}

export function validateGateResult(
  value: unknown,
  candidates: readonly StagedTurnCandidate[],
): SessionGateResult {
  const record = exactObject(value, ["should_refine", "candidate_turn_ids"]);
  if (typeof record.should_refine !== "boolean") {
    throw new ModelError("model_invalid_structured_output");
  }
  if (!Array.isArray(record.candidate_turn_ids)) {
    throw new ModelError("model_invalid_structured_output");
  }
  const allowed = new Set(candidates.map((candidate) => candidate.turn_id));
  const selected = record.candidate_turn_ids;
  if (
    selected.length > 25 ||
    selected.some((id) => typeof id !== "string" || !allowed.has(id)) ||
    new Set(selected).size !== selected.length ||
    (!record.should_refine && selected.length > 0) ||
    (record.should_refine && selected.length === 0)
  ) {
    throw new ModelError("model_invalid_structured_output");
  }
  return {
    should_refine: record.should_refine,
    candidate_turn_ids: selected as string[],
  };
}

export function validateRefinerResult(
  value: unknown,
  input: SessionRefinerInput,
): SessionRefinerResult {
  const record = exactObject(value, ["edits"]);
  if (!Array.isArray(record.edits) || record.edits.length > MAX_REFINER_EDITS) {
    throw new ModelError("model_invalid_structured_output");
  }
  const selected = new Set(input.selected_turn_ids);
  const active = new Map(input.active_memories.map((memory) => [memory.id, memory]));
  const usedTurns = new Set<string>();
  const edits = record.edits.map((item) => {
    const edit = exactObject(item, [
      "action",
      "source_turn_id",
      "target_memory_id",
      "base_version",
      "memory",
    ]);
    if (
      (edit.action !== "create" && edit.action !== "update") ||
      typeof edit.source_turn_id !== "string" ||
      !selected.has(edit.source_turn_id) ||
      usedTurns.has(edit.source_turn_id)
    ) {
      throw new ModelError("model_invalid_structured_output");
    }
    usedTurns.add(edit.source_turn_id);
    const memory = validateMemoryCard(edit.memory);
    validateEditTarget(edit, active);
    return {
      action: edit.action,
      source_turn_id: edit.source_turn_id,
      target_memory_id: edit.target_memory_id,
      base_version: edit.base_version,
      memory,
    } as SessionRefinerEdit;
  });
  return { edits };
}

function redactInput<T extends SessionGateInput>(input: T): T {
  return structuredClone({
    ...input,
    turns: input.turns.map((turn) => ({
      turn_id: turn.turn_id,
      user_prompt: redactSecrets(turn.user_prompt),
      final_answer: redactSecrets(turn.final_answer),
    })),
    candidates: input.candidates.map((candidate) => ({
      ...candidate,
      memory: candidate.memory ? redactCard(candidate.memory) : null,
    })),
    active_memories: input.active_memories.map((memory) => ({
      id: memory.id,
      version: memory.version,
      ...redactCard(memory),
    })),
  });
}

function redactCard(card: MemoryCard): MemoryCard {
  return {
    title: redactSecrets(card.title),
    wrong_behavior: redactSecrets(card.wrong_behavior),
    correct_behavior: redactSecrets(card.correct_behavior),
    applicability: redactSecrets(card.applicability),
  };
}

function validateEditTarget(
  edit: Record<string, unknown>,
  active: ReadonlyMap<string, { version: number }>,
): void {
  if (edit.action === "create") {
    if (edit.target_memory_id !== null || edit.base_version !== null) {
      throw new ModelError("model_invalid_structured_output");
    }
    return;
  }
  if (
    typeof edit.target_memory_id !== "string" ||
    !Number.isInteger(edit.base_version)
  ) {
    throw new ModelError("model_invalid_structured_output");
  }
  const target = active.get(edit.target_memory_id);
  if (!target || target.version !== edit.base_version) {
    throw new ModelError("model_invalid_structured_output");
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelError("model_invalid_structured_output");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ModelError("model_invalid_structured_output");
  }
  return record;
}
