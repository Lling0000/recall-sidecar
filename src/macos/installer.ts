import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_DIRECTORY_NAME } from "../constants.js";
import { type CommandRunner, runMacosCommand } from "./command-runner.js";
import { stageInstallationFiles } from "./file-install.js";
import {
  type InstallLayout,
  installLayout,
  LOCAL_MARKETPLACE_NAME,
} from "./install-layout.js";

export interface InstallerOptions {
  home?: string;
  projectRoot?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  command?: CommandRunner;
  socketReady?: (path: string) => Promise<void>;
}

export interface InstallResult {
  cliVersion: string;
  layout: InstallLayout;
  pluginSelector: string;
}

export async function installProduct(
  options: InstallerOptions = {},
): Promise<InstallResult> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("macos_required");
  }
  const home = options.home ?? process.env.HOME;
  if (!home) throw new Error("home_unavailable");
  const projectRoot = options.projectRoot ?? inferredProjectRoot();
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const command = options.command ?? runMacosCommand;
  assertNoMemoraxAdapter(home);
  const cliVersion = await supportedCodexVersion(command);
  const layout = installLayout(home);
  await stageInstallationFiles(projectRoot, layout, nodeExecutable);

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
  await commandStep("marketplace_add", () =>
    command("codex", [
      "plugin",
      "marketplace",
      "add",
      layout.marketplaceRoot,
      "--json",
    ]),
  );
  const pluginSelector = `${PLUGIN_DIRECTORY_NAME}@${LOCAL_MARKETPLACE_NAME}`;
  await commandStep("plugin_add", () =>
    command("codex", ["plugin", "add", pluginSelector, "--json"]),
  );
  await restartLaunchAgent(layout, command, options.socketReady ?? waitForSocket);
  return { cliVersion, layout, pluginSelector };
}

function inferredProjectRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, "../..");
}

function assertNoMemoraxAdapter(home: string): void {
  const legacyAdapter = join(
    home,
    ".codex",
    ".memorax-code",
    "plugins",
    "memorax-code-codex-adapter",
  );
  if (existsSync(legacyAdapter)) throw new Error("memorax_adapter_conflict");
}

async function supportedCodexVersion(command: CommandRunner): Promise<string> {
  const { stdout } = await commandStep("version_check", () =>
    command("codex", ["--version"]),
  );
  const match = stdout.trim().match(/^codex-cli\s+(.+)$/u);
  const version = match?.[1];
  if (!version) throw new Error("invalid_codex_cli_version");
  return version;
}

async function restartLaunchAgent(
  layout: InstallLayout,
  command: CommandRunner,
  socketReady: (path: string) => Promise<void>,
): Promise<void> {
  const userId = process.getuid?.();
  if (userId === undefined) throw new Error("user_id_unavailable");
  const domain = `gui/${userId}`;
  await ignoreFailure(() =>
    command("/bin/launchctl", ["bootout", `${domain}/local.codex-memory.sidecar`]),
  );
  await retryCommandStep("launchd_bootstrap", 20, 100, () =>
    command("/bin/launchctl", ["bootstrap", domain, layout.launchAgent]),
  );
  await ignoreFailure(() =>
    command("/bin/launchctl", [
      "kickstart",
      "-k",
      `${domain}/local.codex-memory.sidecar`,
    ]),
  );
  await socketReady(join(layout.dataDirectory, "sidecar.sock"));
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await lstat(path)).isSocket()) return;
    } catch {
      // launchd has not created the socket yet.
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("sidecar_socket_not_ready");
}

async function ignoreFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // Removal and bootout are idempotent pre-install cleanup.
  }
}

async function commandStep<T>(name: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(`install_${name}_failed`);
  }
}

async function retryCommandStep<T>(
  name: string,
  attempts: number,
  delayMilliseconds: number,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch {
      if (attempt === attempts) break;
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, delayMilliseconds),
      );
    }
  }
  throw new Error(`install_${name}_failed`);
}
