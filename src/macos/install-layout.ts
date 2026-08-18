import { join } from "node:path";
import { LAUNCHD_LABEL, PLUGIN_DIRECTORY_NAME } from "../constants.js";
import { runtimePaths } from "../paths.js";

export const LOCAL_MARKETPLACE_NAME = "codex-local-memory-local";

export interface InstallLayout {
  dataDirectory: string;
  runtimeDirectory: string;
  marketplaceRoot: string;
  marketplaceFile: string;
  pluginDirectory: string;
  launchAgent: string;
  stdoutLog: string;
  stderrLog: string;
}

export function installLayout(home: string): InstallLayout {
  const paths = runtimePaths(home);
  const marketplaceRoot = join(paths.dataDirectory, "marketplace");
  return {
    dataDirectory: paths.dataDirectory,
    runtimeDirectory: join(paths.dataDirectory, "runtime"),
    marketplaceRoot,
    marketplaceFile: join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    pluginDirectory: join(marketplaceRoot, "plugins", PLUGIN_DIRECTORY_NAME),
    launchAgent: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    stdoutLog: join(paths.dataDirectory, "sidecar.stdout.log"),
    stderrLog: join(paths.dataDirectory, "sidecar.stderr.log"),
  };
}
