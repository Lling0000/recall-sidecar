import { randomUUID } from "node:crypto";
import type { RepoIdentity } from "../types.js";
import type { DatabaseCore } from "./core.js";
import { identityFromRow, now, row } from "./helpers.js";
import type { BoundSession, ListedRepository, RepositoryRow } from "./types.js";

type SessionRepositoryRow = RepositoryRow & {
  session_id: string;
  client: string;
  native_session_ref: string;
};

export class RepositoryStore {
  constructor(private readonly core: DatabaseCore) {}

  bindSession(
    client: string,
    nativeSessionRef: string,
    identity: RepoIdentity,
    transcriptPath: string | null = null,
  ): BoundSession {
    return this.core.transaction(() => {
      const existing = this.sessionRow(client, nativeSessionRef);
      if (existing) return this.toBoundSession(existing);

      const repository = this.upsertRepository(identity);
      const sessionId = randomUUID();
      this.core.db
        .prepare(
          `INSERT INTO sessions(id,client,native_session_ref,repo_id,transcript_path,started_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(sessionId, client, nativeSessionRef, repository.id, transcriptPath, now());
      return {
        id: sessionId,
        client,
        nativeSessionRef,
        repoId: repository.id,
        identity: identityFromRow(repository),
      };
    });
  }

  getBoundSession(client: string, nativeSessionRef: string): BoundSession | null {
    const value = this.sessionRow(client, nativeSessionRef);
    return value ? this.toBoundSession(value) : null;
  }

  list(): ListedRepository[] {
    const repositories = this.core.db
      .prepare(
        `SELECT r.id,r.kind,r.display_name,r.last_seen_path,
          count(m.id) AS memory_count
         FROM repositories r LEFT JOIN memories m
           ON m.repo_id=r.id AND m.state!='deleted'
         GROUP BY r.id ORDER BY r.updated_at DESC`,
      )
      .all() as unknown as Array<{
      id: string;
      kind: "git" | "folder";
      display_name: string;
      last_seen_path: string;
      memory_count: number;
    }>;
    return repositories.map((repository) => ({
      id: repository.id,
      kind: repository.kind,
      displayName: repository.display_name,
      path: repository.last_seen_path,
      memoryCount: Number(repository.memory_count),
      paused: this.isPaused(repository.id),
    }));
  }

  isPaused(repoId: string): boolean {
    return this.core.getSetting(`repo_paused:${repoId}`) === "true";
  }

  setPaused(repoId: string, paused: boolean): void {
    const exists = row<{ id: string }>(
      this.core.db.prepare("SELECT id FROM repositories WHERE id=?").get(repoId),
    );
    if (!exists) throw new Error("repository_not_found");
    this.core.setSetting(`repo_paused:${repoId}`, String(paused));
  }

  private sessionRow(
    client: string,
    nativeSessionRef: string,
  ): SessionRepositoryRow | null {
    return row<SessionRepositoryRow>(
      this.core.db
        .prepare(
          `SELECT r.*,s.id AS session_id,s.client,s.native_session_ref
           FROM sessions s JOIN repositories r ON r.id=s.repo_id
           WHERE s.client=? AND s.native_session_ref=?`,
        )
        .get(client, nativeSessionRef),
    );
  }

  private upsertRepository(identity: RepoIdentity): RepositoryRow {
    let repository = row<RepositoryRow>(
      this.core.db
        .prepare("SELECT * FROM repositories WHERE kind=? AND identity_fingerprint=?")
        .get(identity.kind, identity.identityFingerprint),
    );
    const timestamp = now();
    if (!repository) {
      const id = randomUUID();
      this.core.db
        .prepare(
          `INSERT INTO repositories(
            id,kind,identity_fingerprint,common_dir_path,root_path,display_name,
            last_seen_path,remote_label,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          identity.kind,
          identity.identityFingerprint,
          identity.commonDirPath,
          identity.rootPath,
          identity.displayName,
          identity.lastSeenPath,
          identity.remoteLabel,
          timestamp,
          timestamp,
        );
      repository = row<RepositoryRow>(
        this.core.db.prepare("SELECT * FROM repositories WHERE id=?").get(id),
      );
    } else {
      this.updateRepository(repository, identity, timestamp);
      repository = row<RepositoryRow>(
        this.core.db
          .prepare("SELECT * FROM repositories WHERE id=?")
          .get(repository.id),
      );
    }
    if (!repository) throw new Error("repository_bind_failed");
    return repository;
  }

  private updateRepository(
    existing: RepositoryRow,
    identity: RepoIdentity,
    timestamp: string,
  ): void {
    const remoteChanged =
      existing.kind === "git" &&
      existing.remote_label !== null &&
      identity.remoteLabel !== null &&
      existing.remote_label !== identity.remoteLabel;
    this.core.db
      .prepare(
        `UPDATE repositories SET last_seen_path=?,display_name=?,remote_label=?,
          remote_warning=CASE WHEN ? THEN 1 ELSE remote_warning END,updated_at=?
         WHERE id=?`,
      )
      .run(
        identity.lastSeenPath,
        identity.displayName,
        identity.remoteLabel,
        remoteChanged ? 1 : 0,
        timestamp,
        existing.id,
      );
    if (remoteChanged) {
      this.core.audit("remote_changed", existing.id, { repo_id: existing.id });
    }
  }

  private toBoundSession(value: SessionRepositoryRow): BoundSession {
    return {
      id: value.session_id,
      client: value.client,
      nativeSessionRef: value.native_session_ref,
      repoId: value.id,
      identity: identityFromRow(value),
    };
  }
}
