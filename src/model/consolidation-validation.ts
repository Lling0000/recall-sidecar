import { validateMemoryCard } from "../security/memory-card.js";
import { redactSecrets } from "../security/redact.js";
import type { CompareCard, MemoryCard } from "../types.js";
import {
  CONSOLIDATION_MAX_INPUT_CHARS,
  MAX_CONSOLIDATION_SUGGESTIONS,
} from "./consolidation-contract.js";
import type {
  ConsolidationInput,
  ConsolidationMemoryRef,
  ConsolidationResult,
  ConsolidationSuggestion,
} from "./consolidation-types.js";
import { ModelError } from "./error.js";

export function prepareConsolidationInput(
  input: ConsolidationInput,
): ConsolidationInput {
  const prepared = {
    active_memories: input.active_memories.map((memory) => ({
      id: memory.id,
      version: memory.version,
      ...redactCard(memory),
    })),
  };
  if (JSON.stringify(prepared).length > CONSOLIDATION_MAX_INPUT_CHARS) {
    throw new ModelError("consolidation_input_too_large");
  }
  return prepared;
}

export function validateConsolidationResult(
  value: unknown,
  input: ConsolidationInput,
): ConsolidationResult {
  const record = exactObject(value, ["suggestions"]);
  if (
    !Array.isArray(record.suggestions) ||
    record.suggestions.length > MAX_CONSOLIDATION_SUGGESTIONS
  ) {
    throw new ModelError("model_invalid_structured_output");
  }
  const active = new Map(input.active_memories.map((memory) => [memory.id, memory]));
  const fingerprints = new Set<string>();
  const suggestions = record.suggestions.map((item) => {
    const suggestion = validateSuggestion(item, active);
    const fingerprint = suggestionFingerprint(suggestion);
    if (fingerprints.has(fingerprint)) invalid();
    fingerprints.add(fingerprint);
    return suggestion;
  });
  return { suggestions };
}

function validateSuggestion(
  value: unknown,
  active: ReadonlyMap<string, CompareCard>,
): ConsolidationSuggestion {
  const item = exactObject(value, [
    "kind",
    "target_memory_id",
    "target_base_version",
    "related_memories",
    "proposed_memory",
    "reason",
  ]);
  if (item.kind !== "merge" && item.kind !== "conflict") invalid();
  if (typeof item.target_memory_id !== "string") invalid();
  if (!Number.isInteger(item.target_base_version)) invalid();
  if (!Array.isArray(item.related_memories) || item.related_memories.length === 0) {
    invalid();
  }
  if (typeof item.reason !== "string" || !validLength(item.reason, 1, 300)) invalid();
  const target = active.get(item.target_memory_id);
  if (!target || target.version !== item.target_base_version) invalid();
  const related = item.related_memories.map((entry) => validateRef(entry, active));
  const ids = related.map((entry) => entry.memory_id);
  if (ids.includes(target.id) || new Set(ids).size !== ids.length) invalid();
  const relatedCards = related.map(
    (entry) => active.get(entry.memory_id) as CompareCard,
  );
  if (relatedCards.some((card) => card.applicability !== target.applicability))
    invalid();

  let proposed: MemoryCard | null = null;
  if (item.kind === "merge") {
    proposed = validateMemoryCard(item.proposed_memory);
    if (
      relatedCards.some((card) => card.kind !== target.kind) ||
      proposed.kind !== target.kind ||
      proposed.applicability !== target.applicability
    ) {
      invalid();
    }
  } else if (item.proposed_memory !== null) invalid();

  return {
    kind: item.kind,
    target_memory_id: target.id,
    target_base_version: target.version,
    related_memories: related,
    proposed_memory: proposed,
    reason: item.reason,
  };
}

function validateRef(
  value: unknown,
  active: ReadonlyMap<string, CompareCard>,
): ConsolidationMemoryRef {
  const entry = exactObject(value, ["memory_id", "base_version"]);
  if (typeof entry.memory_id !== "string" || !Number.isInteger(entry.base_version)) {
    invalid();
  }
  const memory = active.get(entry.memory_id);
  if (!memory || memory.version !== entry.base_version) invalid();
  return { memory_id: memory.id, base_version: memory.version };
}

function suggestionFingerprint(suggestion: ConsolidationSuggestion): string {
  return [
    suggestion.kind,
    ...[
      `${suggestion.target_memory_id}@${suggestion.target_base_version}`,
      ...suggestion.related_memories.map(
        (memory) => `${memory.memory_id}@${memory.base_version}`,
      ),
    ].sort(),
  ].join("|");
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

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return record;
}

function validLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

function invalid(): never {
  throw new ModelError("model_invalid_structured_output");
}
