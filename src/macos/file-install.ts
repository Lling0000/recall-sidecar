import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallLayout } from "./install-layout.js";
import { launchdPlist } from "./launchd.js";
import { hookWrapper, marketplaceManifest } from "./marketplace.js";

export async function stageInstallationFiles(
  projectRoot: string,
  layout: InstallLayout,
  nodeExecutable: string,
): Promise<void> {
  const sourceRuntime = join(projectRoot, "dist");
  const sourcePlugin = join(projectRoot, "plugin", "codex-local-memory");
  await mkdir(layout.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(layout.dataDirectory, 0o700);
  await replaceDirectory(sourceRuntime, layout.runtimeDirectory);
  await replaceDirectory(sourcePlugin, layout.pluginDirectory);
  await cp(sourceRuntime, join(layout.pluginDirectory, "runtime"), {
    recursive: true,
  });
  const wrapper = join(layout.pluginDirectory, "bin", "codex-local-memory-hook");
  await mkdir(dirname(wrapper), { recursive: true });
  await writeFile(wrapper, hookWrapper(nodeExecutable), { mode: 0o700 });
  await writePrivate(layout.marketplaceFile, marketplaceManifest());
  await writePrivate(layout.launchAgent, launchdPlist(layout, nodeExecutable));
  await writePrivate(layout.stdoutLog, "");
  await writePrivate(layout.stderrLog, "");
}

async function replaceDirectory(source: string, destination: string): Promise<void> {
  const staging = `${destination}.staging-${randomUUID()}`;
  const previous = `${destination}.previous-${randomUUID()}`;
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, staging, { recursive: true });
  try {
    await rename(destination, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(staging, destination);
  await rm(previous, { recursive: true, force: true });
}

async function writePrivate(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
