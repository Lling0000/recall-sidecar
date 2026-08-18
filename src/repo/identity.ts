import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MAX_GIT_ANCESTORS } from "../constants.js";
import type { RepoIdentity } from "../types.js";

type GitDiscovery =
  | { state: "none" }
  | { state: "damaged"; rootPath: string; gitPath: string }
  | {
      state: "valid";
      rootPath: string;
      gitPath: string;
      gitDir: string;
      commonDir: string;
      remoteLabel: string | null;
    };

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    await access(path, fsConstants.R_OK);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function readOriginLabel(commonDir: string): Promise<string | null> {
  try {
    const config = await readFile(join(commonDir, "config"), "utf8");
    let inOrigin = false;
    for (const line of config.split(/\r?\n/u)) {
      const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/u);
      if (section) {
        inOrigin = section[1] === "origin";
        continue;
      }
      if (!inOrigin) continue;
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/u)?.[1];
      if (url) return url;
    }
  } catch {
    // Remote is an optional display label and never part of identity.
  }
  return null;
}

async function resolveGitAt(rootPath: string, gitPath: string): Promise<GitDiscovery> {
  try {
    const gitEntry = await lstat(gitPath);
    let gitDir: string;
    if (gitEntry.isDirectory()) {
      gitDir = await realpath(gitPath);
    } else if (gitEntry.isFile()) {
      const marker = await readFile(gitPath, "utf8");
      const match = marker.match(/^gitdir:\s*(.+?)\s*(?:\r?\n)?$/u);
      if (!match?.[1]) return { state: "damaged", rootPath, gitPath };
      const target = isAbsolute(match[1]) ? match[1] : resolve(rootPath, match[1]);
      gitDir = await realpath(target);
    } else {
      return { state: "damaged", rootPath, gitPath };
    }

    if (!(await isReadableDirectory(gitDir))) {
      return { state: "damaged", rootPath, gitPath };
    }

    let commonDir = gitDir;
    try {
      const commonMarker = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
      if (!commonMarker) return { state: "damaged", rootPath, gitPath };
      commonDir = await realpath(
        isAbsolute(commonMarker) ? commonMarker : resolve(gitDir, commonMarker),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return { state: "damaged", rootPath, gitPath };
    }

    if (!(await isReadableDirectory(commonDir))) {
      return { state: "damaged", rootPath, gitPath };
    }
    await access(join(commonDir, "HEAD"), fsConstants.R_OK);
    const canonicalCommonDir = await realpath(commonDir);
    return {
      state: "valid",
      rootPath,
      gitPath,
      gitDir,
      commonDir: canonicalCommonDir,
      remoteLabel: await readOriginLabel(canonicalCommonDir),
    };
  } catch {
    return { state: "damaged", rootPath, gitPath };
  }
}

async function discoverGit(cwd: string): Promise<GitDiscovery> {
  let cursor = cwd;
  for (let depth = 0; depth < MAX_GIT_ANCESTORS; depth += 1) {
    const gitPath = join(cursor, ".git");
    try {
      await lstat(gitPath);
      return resolveGitAt(cursor, gitPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { state: "damaged", rootPath: cursor, gitPath };
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { state: "none" };
}

function assertFolderScope(rootPath: string): void {
  const name = basename(rootPath);
  if (
    rootPath === "/" ||
    rootPath === homedir() ||
    !name ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("folder_scope_too_broad");
  }
}

export async function resolveRepoIdentity(cwdInput: string): Promise<RepoIdentity> {
  const cwd = await realpath(cwdInput);
  if (!(await isReadableDirectory(cwd))) throw new Error("cwd_not_readable");
  const git = await discoverGit(cwd);

  if (git.state === "valid") {
    return {
      kind: "git",
      identityFingerprint: fingerprint(git.commonDir),
      commonDirPath: git.commonDir,
      rootPath: null,
      displayName: basename(git.rootPath),
      lastSeenPath: cwd,
      remoteLabel: git.remoteLabel,
      discoveredGitPath: git.gitPath,
    };
  }

  const folderRoot = await realpath(git.state === "damaged" ? git.rootPath : cwd);
  assertFolderScope(folderRoot);
  return {
    kind: "folder",
    identityFingerprint: fingerprint(folderRoot),
    commonDirPath: null,
    rootPath: folderRoot,
    displayName: basename(folderRoot),
    lastSeenPath: cwd,
    remoteLabel: null,
    discoveredGitPath: git.state === "damaged" ? git.gitPath : null,
  };
}

export async function cwdMatchesBoundIdentity(
  identity: Pick<RepoIdentity, "kind" | "identityFingerprint" | "rootPath">,
  cwdInput: string,
): Promise<boolean> {
  try {
    const cwd = await realpath(cwdInput);
    if (identity.kind === "git") {
      const current = await resolveRepoIdentity(cwd);
      return (
        current.kind === "git" &&
        current.identityFingerprint === identity.identityFingerprint
      );
    }

    if (!identity.rootPath) return false;
    const pathFromRoot = relative(identity.rootPath, cwd);
    return (
      pathFromRoot === "" ||
      (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
    );
  } catch {
    return false;
  }
}
