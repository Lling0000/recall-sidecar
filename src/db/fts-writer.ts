import type { MemoryCard } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { searchableCardText } from "./search.js";

export function replaceMemoryFts(
  core: DatabaseCore,
  memoryId: string,
  repoId: string,
  card: MemoryCard,
): void {
  core.db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(memoryId);
  core.db
    .prepare("INSERT INTO memory_fts(memory_id,repo_id,searchable_text) VALUES (?,?,?)")
    .run(memoryId, repoId, searchableCardText(card));
}
