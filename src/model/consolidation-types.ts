import type { CompareCard, MemoryCard } from "../types.js";

export interface ConsolidationInput {
  active_memories: CompareCard[];
}

export interface ConsolidationMemoryRef {
  memory_id: string;
  base_version: number;
}

export interface ConsolidationSuggestion {
  kind: "merge" | "conflict" | "split";
  target_memory_id: string;
  target_base_version: number;
  related_memories: ConsolidationMemoryRef[];
  proposed_memories: MemoryCard[];
  reason: string;
}

export interface ConsolidationResult {
  suggestions: ConsolidationSuggestion[];
}
