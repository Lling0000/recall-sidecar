import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MODEL_SCHEMA_REVISION } from "../constants.js";
import { now, row } from "./helpers.js";
import {
  CANDIDATES_TABLE_SQL,
  CONSOLIDATION_SUGGESTIONS_TABLE_SQL,
  DATABASE_SCHEMA,
} from "./schema.js";

const DEFAULT_SETTINGS = {
  auto_recall: "true",
  auto_extract: "false",
  strict_schema_verified: "false",
  prompt_consent: "false",
  final_answer_consent: "false",
} as const;

export class DatabaseCore {
  readonly path: string;
  readonly db: DatabaseSync;
  private writable = true;

  constructor(path: string) {
    this.path = path;
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const existed = existsSync(path);
    this.db = new DatabaseSync(path);

    try {
      this.db.exec("PRAGMA foreign_keys=ON");
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec("PRAGMA busy_timeout=1000");
      if (existed && !this.quickCheck()) {
        throw new Error("sqlite_quick_check_failed");
      }
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec(DATABASE_SCHEMA);
      this.migrateCandidateOrdinals();
      this.migrateConsolidationSuggestionKinds();
      this.db.exec("DROP TABLE IF EXISTS turn_candidates");
      this.ensureDefaults();
      this.enforceModelSchemaRevision();
      chmodSync(path, 0o600);
      this.chmodCompanions();
    } catch (error) {
      this.writable = false;
      this.db.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    if (!this.writable) throw new Error("database_read_only_due_to_integrity");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      this.chmodCompanions();
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original operation failure.
      }
      throw error;
    }
  }

  quickCheck(): boolean {
    return (
      row<{ quick_check: string }>(this.db.prepare("PRAGMA quick_check").get())
        ?.quick_check === "ok"
    );
  }

  close(): void {
    this.db.close();
  }

  setSetting(key: string, value: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, value);
    });
  }

  getSetting(key: string): string | null {
    return (
      row<{ value: string }>(
        this.db.prepare("SELECT value FROM settings WHERE key=?").get(key),
      )?.value ?? null
    );
  }

  extractionEnabled(): boolean {
    return (
      this.getSetting("auto_extract") === "true" &&
      this.getSetting("strict_schema_verified") === "true" &&
      this.getSetting("verified_schema_revision") === MODEL_SCHEMA_REVISION &&
      this.getSetting("prompt_consent") === "true" &&
      this.getSetting("final_answer_consent") === "true"
    );
  }

  audit(
    action: string,
    targetId: string | null,
    metadata: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_events(id,action,target_id,metadata,created_at) VALUES (?,?,?,?,?)",
      )
      .run(randomUUID(), action, targetId, JSON.stringify(metadata), now());
  }

  bumpGeneration(repoId: string): void {
    this.db
      .prepare(
        "UPDATE repositories SET recall_generation=recall_generation+1 WHERE id=?",
      )
      .run(repoId);
    this.db
      .prepare(
        "UPDATE knowledge_consolidation_suggestions SET state='stale',updated_at=? WHERE repo_id=? AND state='pending'",
      )
      .run(now(), repoId);
  }

  private ensureDefaults(): void {
    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)",
    );
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      statement.run(key, value);
    }
  }

  private enforceModelSchemaRevision(): void {
    const verified = row<{ value: string }>(
      this.db
        .prepare("SELECT value FROM settings WHERE key='verified_schema_revision'")
        .get(),
    )?.value;
    if (verified === MODEL_SCHEMA_REVISION) return;
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('auto_extract','false') ON CONFLICT(key) DO UPDATE SET value='false'",
      )
      .run();
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('strict_schema_verified','false') ON CONFLICT(key) DO UPDATE SET value='false'",
      )
      .run();
  }

  private migrateCandidateOrdinals(): void {
    const columns = this.db.prepare("PRAGMA table_info(candidates)").all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "edit_ordinal")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("ALTER TABLE candidates RENAME TO candidates_legacy");
      this.db.exec(CANDIDATES_TABLE_SQL);
      this.db.exec(`INSERT INTO candidates(
        id,refine_job_id,edit_ordinal,repo_id,action,target_id,applied_memory_id,
        base_version,revision,content,state,review_state,created_at
      ) SELECT id,refine_job_id,0,repo_id,action,target_id,applied_memory_id,
        base_version,revision,content,state,review_state,created_at
        FROM candidates_legacy`);
      this.db.exec("DROP TABLE candidates_legacy");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateConsolidationSuggestionKinds(): void {
    const definition = row<{ sql: string }>(
      this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_consolidation_suggestions'",
        )
        .get(),
    )?.sql;
    if (definition?.includes("'split'")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        "ALTER TABLE knowledge_consolidation_suggestions RENAME TO consolidation_suggestions_legacy",
      );
      this.db.exec(CONSOLIDATION_SUGGESTIONS_TABLE_SQL);
      this.db.exec(`INSERT INTO knowledge_consolidation_suggestions(
        id,job_id,repo_id,kind,target_memory_id,target_base_version,related_json,
        proposed_content,reason,fingerprint,state,created_at,updated_at
      ) SELECT id,job_id,repo_id,kind,target_memory_id,target_base_version,
        related_json,proposed_content,reason,fingerprint,state,created_at,updated_at
        FROM consolidation_suggestions_legacy`);
      this.db.exec("DROP TABLE consolidation_suggestions_legacy");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private chmodCompanions(): void {
    for (const suffix of ["-wal", "-shm"]) {
      const companion = `${this.path}${suffix}`;
      if (existsSync(companion) && statSync(companion).isFile()) {
        chmodSync(companion, 0o600);
      }
    }
  }
}
