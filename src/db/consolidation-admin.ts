import { randomUUID } from "node:crypto";
import {
  validateMemoryCard,
  validateStoredMemoryCard,
} from "../security/memory-card.js";
import type { MemoryCard } from "../types.js";
import { applyConsolidationSplit } from "./consolidation-split-apply.js";
import type { DatabaseCore } from "./core.js";
import { replaceMemoryFts } from "./fts-writer.js";
import { now, parseCard, row, topicKey } from "./helpers.js";
import type { ConsolidationReviewCard, PendingConsolidationReview } from "./types.js";

export class KnowledgeConsolidationAdmin {
  constructor(private readonly core: DatabaseCore) {}

  listPending(): PendingConsolidationReview[] {
    const values = this.core.db
      .prepare(
        `SELECT s.id,s.repo_id,s.kind,s.target_memory_id,s.target_base_version,
          s.related_json,s.proposed_content,s.reason,r.display_name
         FROM knowledge_consolidation_suggestions s
         JOIN repositories r ON r.id=s.repo_id
         WHERE s.state='pending' ORDER BY s.created_at DESC`,
      )
      .all() as unknown as SuggestionRow[];
    return values.flatMap((value) => {
      const target = this.versionCard(
        value.target_memory_id,
        value.target_base_version,
      );
      const related = parseReferences(value.related_json).map((reference) =>
        this.versionCard(reference.memory_id, reference.base_version),
      );
      if (!target || related.some((memory) => !memory)) return [];
      return [
        {
          suggestionId: value.id,
          kind: value.kind,
          repoId: value.repo_id,
          repoDisplayName: value.display_name,
          target,
          related: related as ConsolidationReviewCard[],
          proposedMemories: parseStoredProposedCards(value.proposed_content),
          reason: value.reason,
        },
      ];
    });
  }

  ignore(suggestionId: string): void {
    this.core.transaction(() => {
      const changed = this.core.db
        .prepare(
          "UPDATE knowledge_consolidation_suggestions SET state='ignored',updated_at=? WHERE id=? AND state='pending'",
        )
        .run(now(), suggestionId);
      if (changed.changes !== 1)
        throw new Error("consolidation_suggestion_not_pending");
      this.core.audit("knowledge_consolidation_ignored", suggestionId, {});
    });
  }

  apply(suggestionId: string): "applied" | "stale" {
    return this.core.transaction(() => {
      const suggestion = this.pendingApplicable(suggestionId);
      if (!suggestion) throw new Error("consolidation_suggestion_not_applicable");
      const target = this.activeVersion(
        suggestion.repo_id,
        suggestion.target_memory_id,
        suggestion.target_base_version,
      );
      if (!target) {
        this.markStale(suggestionId);
        return "stale";
      }
      const references = parseReferences(suggestion.related_json);
      let proposed: MemoryCard[];
      try {
        proposed = parseProposedCards(suggestion.proposed_content);
      } catch {
        this.markStale(suggestionId);
        return "stale";
      }
      if (suggestion.kind === "split") {
        return applyConsolidationSplit(
          this.core,
          suggestionId,
          suggestion.repo_id,
          target,
          proposed,
          references.length,
        );
      }
      const related = references.map((reference) =>
        this.activeVersion(
          suggestion.repo_id,
          reference.memory_id,
          reference.base_version,
        ),
      );
      if (related.some((memory) => !memory)) {
        this.markStale(suggestionId);
        return "stale";
      }
      const merged = proposed[0];
      const relatedValues = related as ActiveVersion[];
      if (
        !merged ||
        proposed.length !== 1 ||
        !validMergeShape(merged, target, relatedValues)
      ) {
        this.markStale(suggestionId);
        return "stale";
      }
      const timestamp = now();
      for (const memory of relatedValues) {
        this.core.db.prepare("DELETE FROM memory_fts WHERE memory_id=?").run(memory.id);
        this.core.db
          .prepare("UPDATE memories SET state='archived',updated_at=? WHERE id=?")
          .run(timestamp, memory.id);
      }
      const versionId = randomUUID();
      const version = target.version + 1;
      this.core.db
        .prepare(
          `INSERT INTO memory_versions(id,memory_id,version_no,content,created_at)
           VALUES (?,?,?,?,?)`,
        )
        .run(versionId, target.id, version, JSON.stringify(merged), timestamp);
      this.core.db
        .prepare(
          `UPDATE memories SET active_version_id=?,topic_key=?,updated_at=?
           WHERE id=? AND state='active'`,
        )
        .run(versionId, topicKey(merged.title), timestamp, target.id);
      replaceMemoryFts(this.core, target.id, suggestion.repo_id, merged);
      this.core.db
        .prepare(
          "UPDATE knowledge_consolidation_suggestions SET state='applied',updated_at=? WHERE id=?",
        )
        .run(timestamp, suggestionId);
      this.core.bumpGeneration(suggestion.repo_id);
      this.core.audit("knowledge_consolidation_applied", suggestionId, {
        repo_id: suggestion.repo_id,
        target_memory_id: target.id,
        archived_memory_ids: relatedValues.map((memory) => memory.id),
        version,
      });
      return "applied";
    });
  }

  private pendingApplicable(suggestionId: string): ApplicableRow | null {
    return row<ApplicableRow>(
      this.core.db
        .prepare(
          `SELECT kind,repo_id,target_memory_id,target_base_version,related_json,proposed_content
           FROM knowledge_consolidation_suggestions
           WHERE id=? AND kind IN ('merge','split') AND state='pending'
             AND proposed_content IS NOT NULL`,
        )
        .get(suggestionId),
    );
  }

  private activeVersion(
    repoId: string,
    memoryId: string,
    version: number,
  ): ActiveVersion | null {
    const value = row<{ id: string; version_no: number; content: string }>(
      this.core.db
        .prepare(
          `SELECT m.id,mv.version_no,mv.content FROM memories m
           JOIN memory_versions mv ON mv.id=m.active_version_id
           LEFT JOIN deletion_tombstones d ON d.memory_id=m.id
           WHERE m.id=? AND m.repo_id=? AND m.state='active'
             AND mv.version_no=? AND d.memory_id IS NULL`,
        )
        .get(memoryId, repoId, version),
    );
    return value
      ? { id: value.id, version: value.version_no, card: parseCard(value.content) }
      : null;
  }

  private versionCard(
    memoryId: string,
    version: number,
  ): ConsolidationReviewCard | null {
    const value = row<{ content: string }>(
      this.core.db
        .prepare(
          "SELECT content FROM memory_versions WHERE memory_id=? AND version_no=?",
        )
        .get(memoryId, version),
    );
    return value ? { memoryId, version, card: parseCard(value.content) } : null;
  }

  private markStale(suggestionId: string): void {
    this.core.db
      .prepare(
        "UPDATE knowledge_consolidation_suggestions SET state='stale',updated_at=? WHERE id=?",
      )
      .run(now(), suggestionId);
  }
}

function validMergeShape(
  proposed: MemoryCard,
  target: ActiveVersion,
  related: readonly ActiveVersion[],
): boolean {
  return (
    proposed.kind === target.card.kind &&
    proposed.applicability === target.card.applicability &&
    related.every(
      (memory) =>
        memory.card.kind === target.card.kind &&
        memory.card.applicability === target.card.applicability,
    )
  );
}

function parseProposedCards(value: string | null): MemoryCard[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.map((memory) => validateMemoryCard(memory))
    : [validateMemoryCard(parsed)];
}

function parseStoredProposedCards(value: string | null): MemoryCard[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.map((memory) => validateStoredMemoryCard(memory))
    : [validateStoredMemoryCard(parsed)];
}

function parseReferences(
  value: string,
): Array<{ memory_id: string; base_version: number }> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid_consolidation_references");
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { memory_id?: unknown }).memory_id !== "string" ||
      !Number.isInteger((entry as { base_version?: unknown }).base_version)
    ) {
      throw new Error("invalid_consolidation_references");
    }
    return entry as { memory_id: string; base_version: number };
  });
}

interface SuggestionRow {
  id: string;
  repo_id: string;
  kind: "merge" | "conflict" | "split";
  target_memory_id: string;
  target_base_version: number;
  related_json: string;
  proposed_content: string | null;
  reason: string;
  display_name: string;
}

interface ApplicableRow {
  kind: "merge" | "split";
  repo_id: string;
  target_memory_id: string;
  target_base_version: number;
  related_json: string;
  proposed_content: string;
}

interface ActiveVersion {
  id: string;
  version: number;
  card: MemoryCard;
}
