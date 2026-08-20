import { existsSync } from "node:fs";
import {
  RECALL_KNOWLEDGE_MAX_CHARS,
  RECALL_LIMIT,
  RECALL_MAX_CHARS,
  RECALL_NOTICE,
} from "../constants.js";
import type { CompareCard } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { parseCard, row } from "./helpers.js";
import { safeFtsQuery } from "./search.js";
import type { ListedMemory, ListedVersion, PendingReview } from "./types.js";

export class MemoryQueryStore {
  constructor(private readonly core: DatabaseCore) {}

  search(repoId: string, prompt: string, limit = RECALL_LIMIT): CompareCard[] {
    const query = safeFtsQuery(prompt);
    if (!query) return [];
    const rows = this.core.db
      .prepare(
        `SELECT m.id,mv.version_no AS version,mv.content
         FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id
         JOIN memory_versions mv ON mv.id=m.active_version_id
         WHERE memory_fts MATCH ? AND memory_fts.repo_id=?
           AND m.repo_id=? AND m.state='active'
         ORDER BY bm25(memory_fts),mv.created_at DESC LIMIT ?`,
      )
      .all(query, repoId, repoId, limit) as unknown as Array<{
      id: string;
      version: number;
      content: string;
    }>;
    return rows.map((value) => ({
      id: value.id,
      version: value.version,
      ...parseCard(value.content),
    }));
  }

  recall(repoId: string, prompt: string): string {
    if (this.core.getSetting("auto_recall") !== "true") return "";
    const cards = this.search(repoId, prompt);
    if (cards.length === 0) return "";
    const lines = [RECALL_NOTICE];
    for (const card of cards) {
      const applicability = card.applicability ? `（${card.applicability}）` : "";
      const knowledge = compactKnowledge(card.knowledge);
      const next = `[${card.kind}] ${card.title}：${knowledge}${applicability}`;
      if ([...lines, next].join("\n").length > RECALL_MAX_CHARS) break;
      lines.push(next);
    }
    return lines.length > 1 ? lines.join("\n") : "";
  }

  listMemories(repoId?: string): ListedMemory[] {
    const rows = this.core.db
      .prepare(
        `SELECT m.id,m.repo_id,r.display_name,r.last_seen_path,m.state,
          mv.id AS version_id,mv.version_no,mv.content,mv.source_turn_ref,
          s.native_session_ref,m.updated_at
         FROM memories m JOIN repositories r ON r.id=m.repo_id
         JOIN memory_versions mv ON mv.id=m.active_version_id
         LEFT JOIN sessions s ON s.id=mv.source_session_id
         WHERE (? IS NULL OR m.repo_id=?) AND m.state!='deleted'
         ORDER BY m.updated_at DESC`,
      )
      .all(repoId ?? null, repoId ?? null) as unknown as MemoryListRow[];
    return rows.map((value) => ({
      id: value.id,
      repoId: value.repo_id,
      repoDisplayName: value.display_name,
      repoPath: value.last_seen_path,
      state: value.state,
      activeVersion: value.version_no,
      activeVersionId: value.version_id,
      card: parseCard(value.content),
      sourceSessionRef: value.native_session_ref,
      sourceTurnRef: value.source_turn_ref,
      updatedAt: value.updated_at,
    }));
  }

  listVersions(memoryId: string): ListedVersion[] {
    const rows = this.core.db
      .prepare(
        `SELECT id,version_no,content,restores_version_id,created_at
         FROM memory_versions WHERE memory_id=? ORDER BY version_no DESC`,
      )
      .all(memoryId) as unknown as VersionRow[];
    return rows.map((value) => ({
      id: value.id,
      version: value.version_no,
      card: parseCard(value.content),
      restoresVersionId: value.restores_version_id,
      createdAt: value.created_at,
    }));
  }

  listPendingReviews(): PendingReview[] {
    const rows = this.core.db
      .prepare(
        `SELECT c.id AS candidate_id,c.action,c.applied_memory_id,
          old.id AS old_id,old.version_no AS old_version,old.content AS old_content,
          newer.id AS new_id,newer.version_no AS new_version,newer.content AS new_content,
          s.native_session_ref,t.native_turn_ref
         FROM candidates c JOIN refine_jobs j ON j.id=c.refine_job_id
         JOIN turns t ON t.id=j.turn_id JOIN sessions s ON s.id=t.session_id
         JOIN memories m ON m.id=c.applied_memory_id
         JOIN memory_versions newer ON newer.memory_id=c.applied_memory_id
           AND ((c.action='create' AND newer.version_no=1)
             OR (c.action='update' AND newer.version_no=c.base_version+1))
         LEFT JOIN memory_versions old ON c.action='update'
           AND old.memory_id=c.applied_memory_id AND old.version_no=c.base_version
         WHERE c.state='applied'
           AND (c.review_state='unverified'
             OR (c.action='create' AND c.review_state='none'))
           AND m.state='active' AND m.active_version_id=newer.id
         ORDER BY c.created_at DESC`,
      )
      .all() as unknown as ReviewRow[];
    return rows.map((value) => ({
      action: value.action,
      candidateId: value.candidate_id,
      memoryId: value.applied_memory_id,
      oldVersionId: value.old_id,
      oldVersion: value.old_version,
      oldCard: value.old_content ? parseCard(value.old_content) : null,
      newVersionId: value.new_id,
      newVersion: value.new_version,
      newCard: parseCard(value.new_content),
      sourceSessionRef: value.native_session_ref,
      sourceTurnRef: value.native_turn_ref,
    }));
  }

  health(): Record<string, unknown> {
    const count = (sql: string): number =>
      Number(row<{ count: number }>(this.core.db.prepare(sql).get())?.count ?? 0);
    return {
      sqlite: this.core.quickCheck() ? "ok" : "corrupt",
      auto_recall: this.core.getSetting("auto_recall") === "true",
      auto_extract: this.core.extractionEnabled(),
      strict_schema_verified: this.core.getSetting("strict_schema_verified") === "true",
      stale_candidates: count(
        "SELECT count(*) AS count FROM candidates WHERE state='stale'",
      ),
      pending_checkpoint_turns: count(
        "SELECT count(*) AS count FROM session_turn_queue WHERE state='pending'",
      ),
      failed_session_refines: count(
        `SELECT count(*) AS count FROM session_refine_jobs sr
         WHERE sr.state='failed' AND EXISTS (
           SELECT 1 FROM session_refine_job_turns jt
           JOIN session_turn_queue q ON q.turn_id=jt.turn_id
           WHERE jt.session_refine_job_id=sr.id
             AND jt.role='eligible' AND q.state='pending'
         )`,
      ),
      remote_warnings: count(
        "SELECT count(*) AS count FROM repositories WHERE remote_warning=1",
      ),
    };
  }

  sourceStatus(nativeSessionRef: string): {
    command: string | null;
    available: boolean;
  } {
    if (!/^[A-Za-z0-9_-]+$/u.test(nativeSessionRef)) {
      return { command: null, available: false };
    }
    const source = row<{ transcript_path: string | null }>(
      this.core.db
        .prepare(
          "SELECT transcript_path FROM sessions WHERE client='codex' AND native_session_ref=?",
        )
        .get(nativeSessionRef),
    );
    return {
      command: `codex resume ${nativeSessionRef}`,
      available:
        source?.transcript_path !== null &&
        source?.transcript_path !== undefined &&
        existsSync(source.transcript_path),
    };
  }
}

interface MemoryListRow {
  id: string;
  repo_id: string;
  display_name: string;
  last_seen_path: string;
  state: string;
  version_id: string;
  version_no: number;
  content: string;
  source_turn_ref: string | null;
  native_session_ref: string | null;
  updated_at: string;
}

interface VersionRow {
  id: string;
  version_no: number;
  content: string;
  restores_version_id: string | null;
  created_at: string;
}

interface ReviewRow {
  action: "create" | "update";
  candidate_id: string;
  applied_memory_id: string;
  old_id: string | null;
  old_version: number | null;
  old_content: string | null;
  new_id: string;
  new_version: number;
  new_content: string;
  native_session_ref: string | null;
  native_turn_ref: string | null;
}

function compactKnowledge(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= RECALL_KNOWLEDGE_MAX_CHARS) return value;
  return `${characters
    .slice(0, RECALL_KNOWLEDGE_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}
