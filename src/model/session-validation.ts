import { validateMemoryCard } from "../security/memory-card.js";
import { redactSecrets } from "../security/redact.js";
import type { MemoryCard } from "../types.js";
import { ModelError } from "./error.js";
import { MAX_REFINER_EDITS } from "./session-contract.js";
import type {
  SessionGateInput,
  SessionGateResult,
  SessionRefinerEdit,
  SessionRefinerInput,
  SessionRefinerResult,
} from "./session-types.js";

export function prepareSessionInput<T extends SessionGateInput>(
  input: T,
  maxChars: number,
): T {
  const prepared = redactInput(input);
  while (
    JSON.stringify(prepared).length > maxChars &&
    prepared.turns.some((turn) => !prepared.eligible_turn_ids.includes(turn.turn_id))
  ) {
    const index = prepared.turns.findIndex(
      (turn) => !prepared.eligible_turn_ids.includes(turn.turn_id),
    );
    if (index >= 0) prepared.turns.splice(index, 1);
  }
  while (
    JSON.stringify(prepared).length > maxChars &&
    prepared.eligible_turn_ids.length > 1
  ) {
    const removed = prepared.eligible_turn_ids.pop();
    prepared.turns = prepared.turns.filter((turn) => turn.turn_id !== removed);
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
  eligibleTurnIds: readonly string[],
): SessionGateResult {
  const record = exactObject(value, ["should_refine", "selected_turn_ids"]);
  if (typeof record.should_refine !== "boolean") {
    throw new ModelError("model_invalid_structured_output");
  }
  if (!Array.isArray(record.selected_turn_ids)) {
    throw new ModelError("model_invalid_structured_output");
  }
  const allowed = new Set(eligibleTurnIds);
  const selected = record.selected_turn_ids;
  if (
    selected.length > 8 ||
    selected.some((id) => typeof id !== "string" || !allowed.has(id)) ||
    new Set(selected).size !== selected.length ||
    (!record.should_refine && selected.length > 0) ||
    (record.should_refine && selected.length === 0)
  ) {
    throw new ModelError("model_invalid_structured_output");
  }
  return {
    should_refine: record.should_refine,
    selected_turn_ids: selected as string[],
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
    eligible_turn_ids: [...input.eligible_turn_ids],
    active_memories: input.active_memories.map((memory) => ({
      id: memory.id,
      version: memory.version,
      ...redactCard(memory),
    })),
  });
}

function redactCard(card: MemoryCard): MemoryCard {
  return {
    kind: card.kind,
    title: redactSecrets(card.title),
    knowledge: redactSecrets(card.knowledge),
    rationale: redactSecrets(card.rationale),
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
