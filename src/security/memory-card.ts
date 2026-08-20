import type { MemoryCard } from "../types.js";

const CARD_KEYS = ["kind", "title", "knowledge", "rationale", "applicability"] as const;
const NEW_KNOWLEDGE_MAX_CHARS = 120;
const STORED_KNOWLEDGE_MAX_CHARS = 240;

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
  return validateCard(value, NEW_KNOWLEDGE_MAX_CHARS);
}

export function validateStoredMemoryCard(value: unknown): MemoryCard {
  return validateCard(value, STORED_KNOWLEDGE_MAX_CHARS);
}

function validateCard(value: unknown, knowledgeMaxChars: number): MemoryCard {
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
  if (!new Set(["decision", "invariant", "pitfall", "lesson"]).has(card.kind)) {
    throw new Error("memory_kind_value");
  }
  if (
    characterLength(card.knowledge) < 1 ||
    characterLength(card.knowledge) > knowledgeMaxChars
  ) {
    throw new Error("memory_knowledge_length");
  }
  if (characterLength(card.rationale) < 1 || characterLength(card.rationale) > 200) {
    throw new Error("memory_rationale_length");
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
