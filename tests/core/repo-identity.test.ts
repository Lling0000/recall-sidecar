import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cwdMatchesBoundIdentity,
  resolveRepoIdentity,
} from "../../src/repo/identity.js";

async function gitDirectory(path: string, remote?: string): Promise<void> {
  await mkdir(join(path, ".git"), { recursive: true });
  await writeFile(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (remote) {
    await writeFile(
      join(path, ".git", "config"),
      `[remote "origin"]\n  url = ${remote}\n`,
    );
  }
}

test("same-name Git clones remain isolated without executing git", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-repo-"));
  const first = join(root, "org-a", "demo");
  const second = join(root, "org-b", "demo");
  await gitDirectory(first, "ssh://example.test/a/demo.git");
  await gitDirectory(second, "ssh://example.test/b/demo.git");

  const a = await resolveRepoIdentity(first);
  const b = await resolveRepoIdentity(second);
  assert.equal(a.kind, "git");
  assert.equal(b.kind, "git");
  assert.equal(a.displayName, b.displayName);
  assert.notEqual(a.identityFingerprint, b.identityFingerprint);
});

test("P0-17 linked worktree shares common_dir while an independent clone does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-worktree-"));
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  const clone = join(root, "clone");
  await gitDirectory(primary);
  await mkdir(join(primary, ".git", "worktrees", "linked"), { recursive: true });
  await writeFile(join(primary, ".git", "worktrees", "linked", "commondir"), "../..\n");
  await mkdir(linked, { recursive: true });
  await writeFile(
    join(linked, ".git"),
    `gitdir: ${join(primary, ".git", "worktrees", "linked")}\n`,
  );
  await gitDirectory(clone);

  const primaryIdentity = await resolveRepoIdentity(primary);
  const linkedIdentity = await resolveRepoIdentity(linked);
  const cloneIdentity = await resolveRepoIdentity(clone);
  assert.equal(primaryIdentity.identityFingerprint, linkedIdentity.identityFingerprint);
  assert.notEqual(
    primaryIdentity.identityFingerprint,
    cloneIdentity.identityFingerprint,
  );
});

test("P0-18 folder identities use real root paths and moving creates a new identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-folder-"));
  const first = join(root, "one", "demo");
  const second = join(root, "two", "demo");
  const moved = join(root, "moved", "demo");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(join(root, "moved"), { recursive: true });
  const firstIdentity = await resolveRepoIdentity(first);
  const secondIdentity = await resolveRepoIdentity(second);
  assert.notEqual(
    firstIdentity.identityFingerprint,
    secondIdentity.identityFingerprint,
  );

  await rename(first, moved);
  const movedIdentity = await resolveRepoIdentity(moved);
  assert.notEqual(firstIdentity.identityFingerprint, movedIdentity.identityFingerprint);
});

test("damaged .git fixes the folder root at the discovered level", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-damaged-"));
  const project = join(root, "project");
  const nested = join(project, "packages", "app");
  await mkdir(nested, { recursive: true });
  await writeFile(join(project, ".git"), "not-a-gitdir-marker\n");

  const identity = await resolveRepoIdentity(nested);
  assert.equal(identity.kind, "folder");
  assert.equal(identity.rootPath, await realpath(project));
  assert.equal(await cwdMatchesBoundIdentity(identity, nested), true);
  assert.equal(await cwdMatchesBoundIdentity(identity, root), false);
});
