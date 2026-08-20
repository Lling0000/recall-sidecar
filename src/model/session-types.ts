import type { CompareCard, MemoryCard } from "../types.js";

export interface SessionTurnContext {
  turn_id: string;
  user_prompt: string;
  final_answer: string;
}

export interface CheckpointTurnSource {
  job_id: string;
  turn_id: string;
}

export interface SessionGateInput {
  turns: SessionTurnContext[];
  eligible_turn_ids: string[];
  active_memories: CompareCard[];
}

export interface SessionGateResult {
  should_refine: boolean;
  selected_turn_ids: string[];
}

export interface SessionRefinerInput extends SessionGateInput {
  selected_turn_ids: string[];
}

export interface SessionRefinerEdit {
  action: "create" | "update";
  source_turn_id: string;
  target_memory_id: string | null;
  base_version: number | null;
  memory: MemoryCard;
}

export interface SessionRefinerResult {
  edits: SessionRefinerEdit[];
}
