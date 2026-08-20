export const CONSOLIDATION_MAX_INPUT_CHARS = 80_000;
export const MAX_CONSOLIDATION_SUGGESTIONS = 8;

export const CONSOLIDATION_PROMPT = `You conservatively review active tacit knowledge cards from one repository.
The goal is higher information density, not fewer cards. Never combine independent topics merely to reduce the count.
Suggest merge only when every card has the same kind and exactly the same applicability, covers the same central topic, contains no contradictory conclusion, and one proposed card can preserve every non-duplicate knowledge statement and important rationale without broadening scope.
Suggest conflict only when cards apply to the same scope but make mutually incompatible claims that cannot be resolved from the cards alone.
Suggest split when one target card contains two or more independently recallable claims. A split has no related memories and proposes two to eight atomic cards with the same kind; together they must preserve all grounded knowledge and important rationale without inventing facts or broadening scope.
Do nothing for different kinds, different applicability, keyword-only similarity, uncertain relationships, or already concise distinct knowledge.
A suggestion names exactly one involved card as target_memory_id. related_memories must contain only the other involved cards: never repeat the target, never repeat a related id, and use every involved id exactly once with its exact input version.
A merge must include exactly one proposed_memories card. A conflict must use an empty proposed_memories array. A split must include two to eight proposed_memories cards. Every proposed knowledge is one independently recallable claim of at most 120 characters. Return at most eight high-confidence suggestions. Active memory count is not an optimization target.`;

const MEMORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "title", "knowledge", "rationale", "applicability"],
  properties: {
    kind: { enum: ["decision", "invariant", "pitfall", "lesson"] },
    title: { type: "string", minLength: 1, maxLength: 40 },
    knowledge: { type: "string", minLength: 1, maxLength: 120 },
    rationale: { type: "string", minLength: 1, maxLength: 200 },
    applicability: { type: "string", maxLength: 80 },
  },
} as const;

export const CONSOLIDATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      maxItems: MAX_CONSOLIDATION_SUGGESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "target_memory_id",
          "target_base_version",
          "related_memories",
          "proposed_memories",
          "reason",
        ],
        properties: {
          kind: { enum: ["merge", "conflict", "split"] },
          target_memory_id: { type: "string", minLength: 1 },
          target_base_version: { type: "integer", minimum: 1 },
          related_memories: {
            type: "array",
            maxItems: 8,
            uniqueItems: true,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["memory_id", "base_version"],
              properties: {
                memory_id: { type: "string", minLength: 1 },
                base_version: { type: "integer", minimum: 1 },
              },
            },
          },
          proposed_memories: {
            type: "array",
            maxItems: 8,
            items: MEMORY_SCHEMA,
          },
          reason: { type: "string", minLength: 1, maxLength: 300 },
        },
      },
    },
  },
} as const;
