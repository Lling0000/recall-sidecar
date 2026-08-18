import type { CompareCard, ExtractResult, MemoryCard } from "../types.js";

export const EXTRACT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "target_memory_id", "base_version", "memory"],
  properties: {
    action: {
      enum: ["skip", "reject", "create", "update", "need_prev_turn"],
    },
    target_memory_id: { type: ["string", "null"] },
    base_version: { type: ["integer", "null"], minimum: 1 },
    memory: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["title", "wrong_behavior", "correct_behavior", "applicability"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 40 },
        wrong_behavior: { type: "string", maxLength: 120 },
        correct_behavior: {
          type: "string",
          minLength: 1,
          maxLength: 240,
        },
        applicability: { type: "string", maxLength: 80 },
      },
    },
  },
} as const;

const CARD_KEYS = [
  "title",
  "wrong_behavior",
  "correct_behavior",
  "applicability",
] as const;

const FORBIDDEN_CONTENT = [
  /```/u,
  /https?:\/\//iu,
  /<(?:system|assistant|developer|tool|user)(?:\s|>|:)/iu,
  /(?:^|\n)\s*(?:system|assistant|developer|tool|user)\s*:/iu,
  /<\|(?:system|assistant|developer|tool|user)[^|]*\|>/iu,
  /"(?:tool_call|function_call|arguments|role)"\s*:/iu,
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

export function validateMemoryCard(value: unknown): MemoryCard {
  if (!isObject(value)) throw new Error("memory_not_object");
  const keys = Object.keys(value).sort();
  const expectedKeys = [...CARD_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("memory_additional_or_missing_field");
  }

  for (const key of CARD_KEYS) {
    if (typeof value[key] !== "string") throw new Error(`memory_${key}_type`);
  }

  const card = value as unknown as MemoryCard;
  if (characterLength(card.title) < 1 || characterLength(card.title) > 40) {
    throw new Error("memory_title_length");
  }
  if (characterLength(card.wrong_behavior) > 120) {
    throw new Error("memory_wrong_behavior_length");
  }
  if (
    characterLength(card.correct_behavior) < 1 ||
    characterLength(card.correct_behavior) > 240
  ) {
    throw new Error("memory_correct_behavior_length");
  }
  if (characterLength(card.applicability) > 80) {
    throw new Error("memory_applicability_length");
  }

  for (const field of Object.values(card)) {
    if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(field))) {
      throw new Error("memory_forbidden_content");
    }
  }
  return { ...card };
}

export function validateExtractResult(
  value: unknown,
  compareCards: readonly CompareCard[],
): ExtractResult {
  if (!isObject(value)) throw new Error("response_not_object");
  const keys = Object.keys(value).sort();
  const expected = ["action", "target_memory_id", "base_version", "memory"].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error("response_additional_or_missing_field");
  }

  const allowedActions = new Set([
    "skip",
    "reject",
    "create",
    "update",
    "need_prev_turn",
  ]);
  if (typeof value.action !== "string" || !allowedActions.has(value.action)) {
    throw new Error("response_action");
  }
  const action = value.action as ExtractResult["action"];
  const target = value.target_memory_id;
  const base = value.base_version;
  const memory = value.memory;

  if (action === "create") {
    if (target !== null || base !== null) throw new Error("create_semantics");
    return {
      action,
      target_memory_id: null,
      base_version: null,
      memory: validateMemoryCard(memory),
    };
  }

  if (action === "update") {
    if (typeof target !== "string" || !Number.isInteger(base) || Number(base) < 1) {
      throw new Error("update_semantics");
    }
    const compare = compareCards.find(
      (card) => card.id === target && card.version === base,
    );
    if (!compare) throw new Error("update_target_not_in_compare_set");
    return {
      action,
      target_memory_id: target,
      base_version: Number(base),
      memory: validateMemoryCard(memory),
    };
  }

  if (target !== null || base !== null || memory !== null) {
    throw new Error("null_action_semantics");
  }
  return {
    action,
    target_memory_id: null,
    base_version: null,
    memory: null,
  };
}
