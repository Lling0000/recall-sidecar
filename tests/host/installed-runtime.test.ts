import assert from "node:assert/strict";
import { access, lstat, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import test from "node:test";
import { callSidecar } from "../../src/hooks/ipc-client.js";
import { runMacosCommand } from "../../src/macos/command-runner.js";
import { installLayout } from "../../src/macos/install-layout.js";
import { runtimePaths } from "../../src/paths.js";

const EXPECT_INSTALLED = process.env.CLM_EXPECT_INSTALLED === "1";

test(
  "installed plugin, launchd, dashboard, and private runtime are live",
  { skip: process.platform !== "darwin" || !EXPECT_INSTALLED },
  async () => {
    const home = homedir();
    const layout = installLayout(home);
    const paths = runtimePaths(home);
    await access(layout.launchAgent);
    await access(layout.pluginDirectory);
    assert.equal((await stat(layout.dataDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.database)).mode & 0o777, 0o600);
    const socket = await lstat(paths.socket);
    assert.equal(socket.isSocket(), true);
    assert.equal(socket.mode & 0o777, 0o600);

    const userId = process.getuid?.();
    assert.notEqual(userId, undefined);
    const launchd = await runMacosCommand("/bin/launchctl", [
      "print",
      `gui/${userId}/local.codex-memory.sidecar`,
    ]);
    assert.match(launchd.stdout, /state = running/u);
    assert.match(launchd.stdout, /keepalive/u);

    const plugins = await runMacosCommand("codex", ["plugin", "list"]);
    assert.match(
      plugins.stdout,
      /codex-local-memory@codex-local-memory-local\s+installed, enabled/u,
    );
    const hooks = await readFile(`${layout.pluginDirectory}/hooks/hooks.json`, "utf8");
    assert.deepEqual(
      Object.keys(
        (JSON.parse(hooks) as { hooks: Record<string, unknown> }).hooks,
      ).sort(),
      ["SessionStart", "Stop", "UserPromptSubmit"].sort(),
    );

    const dashboard = await callSidecar(
      paths.socket,
      { type: "dashboard_bootstrap" },
      1_000,
    );
    assert.equal(dashboard.ok, true);
    assert.match(
      dashboard.ok ? (dashboard.dashboard_url ?? "") : "",
      /^http:\/\/127\.0\.0\.1:/u,
    );
  },
);
