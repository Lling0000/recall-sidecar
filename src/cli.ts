#!/usr/bin/env node
import { callSidecar } from "./hooks/ipc-client.js";
import { type HookName, runHook } from "./hooks/runner.js";
import { installProduct } from "./macos/installer.js";
import { uninstallProduct } from "./macos/uninstaller.js";
import { runtimePaths } from "./paths.js";
import { runSidecar } from "./sidecar/runtime.js";

const HOOK_NAMES = new Set<HookName>(["session-start", "user-prompt-submit", "stop"]);

async function main(arguments_: string[]): Promise<number> {
  const [command, action] = arguments_;
  if (command === "hook" && HOOK_NAMES.has(action as HookName)) {
    await runHook(action as HookName);
    return 0;
  }
  if (command === "sidecar" && action === "run") {
    await runSidecar();
    return 0;
  }
  if (command === "dashboard" && action === "url") {
    const response = await callSidecar(
      runtimePaths().socket,
      { type: "dashboard_bootstrap" },
      1_000,
    );
    if (!response.ok || !response.dashboard_url) return 1;
    process.stdout.write(`${response.dashboard_url}\n`);
    return 0;
  }
  if (command === "install") {
    const result = await installProduct();
    process.stdout.write(
      `Installed ${result.pluginSelector} for Codex CLI ${result.cliVersion}.\n` +
        "Review and trust SessionStart, UserPromptSubmit, and Stop in /hooks, then restart Codex.\n",
    );
    return 0;
  }
  if (command === "uninstall") {
    await uninstallProduct();
    process.stdout.write(
      "Uninstalled codex-local-memory runtime and plugin; local memory data was kept.\n",
    );
    return 0;
  }
  if (command === "version" || command === "--version") {
    process.stdout.write("codex-local-memory 0.1.0\n");
    return 0;
  }
  process.stderr.write(
    "Usage: codex-local-memory <install|uninstall|sidecar run|dashboard url|hook EVENT|version>\n",
  );
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const code =
    error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "operation_failed";
  process.stderr.write(`codex-local-memory: ${code}\n`);
  process.exitCode = 1;
}
