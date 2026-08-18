import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { PLUGIN_DIRECTORY_NAME } from "../constants.js";
import { type CommandRunner, runMacosCommand } from "./command-runner.js";
import {
  type InstallLayout,
  installLayout,
  LOCAL_MARKETPLACE_NAME,
} from "./install-layout.js";

export interface UninstallerOptions {
  home?: string;
  platform?: NodeJS.Platform;
  command?: CommandRunner;
}

export async function uninstallProduct(
  options: UninstallerOptions = {},
): Promise<InstallLayout> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("macos_required");
  }
  const layout = installLayout(options.home ?? homedir());
  const command = options.command ?? runMacosCommand;
  const userId = process.getuid?.();
  if (userId === undefined) throw new Error("user_id_unavailable");
  await ignoreFailure(() =>
    command("/bin/launchctl", ["bootout", `gui/${userId}/local.codex-memory.sidecar`]),
  );
  await ignoreFailure(() =>
    command("codex", [
      "plugin",
      "remove",
      `${PLUGIN_DIRECTORY_NAME}@${LOCAL_MARKETPLACE_NAME}`,
      "--json",
    ]),
  );
  await ignoreFailure(() =>
    command("codex", [
      "plugin",
      "marketplace",
      "remove",
      LOCAL_MARKETPLACE_NAME,
      "--json",
    ]),
  );
  await rm(layout.launchAgent, { force: true });
  await rm(layout.runtimeDirectory, { recursive: true, force: true });
  await rm(layout.marketplaceRoot, { recursive: true, force: true });
  return layout;
}

async function ignoreFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // Uninstall is idempotent and leaves the database untouched.
  }
}
