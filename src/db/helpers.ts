import { validateStoredMemoryCard } from "../security/memory-card.js";
import type { MemoryCard, RepoIdentity } from "../types.js";
import type { RepositoryRow } from "./types.js";

export function now(): string {
  return new Date().toISOString();
}

export function row<T>(value: unknown): T | null {
  return value ? (value as T) : null;
}

export function topicKey(title: string): string {
  return title.normalize("NFKC").trim().toLocaleLowerCase();
}

export function parseCard(content: string): MemoryCard {
  return validateStoredMemoryCard(JSON.parse(content));
}

export function identityFromRow(value: RepositoryRow): RepoIdentity {
  return {
    kind: value.kind,
    identityFingerprint: value.identity_fingerprint,
    commonDirPath: value.common_dir_path,
    rootPath: value.root_path,
    displayName: value.display_name,
    lastSeenPath: value.last_seen_path,
    remoteLabel: value.remote_label,
    discoveredGitPath: null,
  };
}
