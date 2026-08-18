import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseCore } from "./core.js";

const BACKUP_PREFIX = "memory-backup-";
const BACKUP_SUFFIX = ".sqlite";
const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export class BackupStore {
  constructor(
    private readonly core: DatabaseCore,
    readonly directory: string,
  ) {}

  create(): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const path = join(this.directory, `${BACKUP_PREFIX}${timestamp}${BACKUP_SUFFIX}`);
    this.core.db.prepare("VACUUM INTO ?").run(path);
    chmodSync(path, 0o600);
    this.prune();
    return path;
  }

  purgeAll(): void {
    if (!directoryExists(this.directory)) return;
    for (const name of readdirSync(this.directory)) {
      if (isManagedBackup(name)) {
        rmSync(join(this.directory, name), { force: true });
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MILLISECONDS;
    for (const name of readdirSync(this.directory)) {
      if (!isManagedBackup(name)) continue;
      const path = join(this.directory, name);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    }
  }
}

function isManagedBackup(name: string): boolean {
  return (
    basename(name) === name &&
    name.startsWith(BACKUP_PREFIX) &&
    name.endsWith(BACKUP_SUFFIX)
  );
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
