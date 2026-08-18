import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommandRunner } from "../../src/macos/command-runner.js";
import { installProduct } from "../../src/macos/installer.js";
import { uninstallProduct } from "../../src/macos/uninstaller.js";

async function projectFixture(root: string): Promise<string> {
  const project = join(root, "source");
  await mkdir(join(project, "dist"), { recursive: true });
  await writeFile(join(project, "dist", "cli.js"), "// built runtime\n");
  const plugin = join(project, "plugin", "codex-local-memory");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  await mkdir(join(plugin, "hooks"), { recursive: true });
  await writeFile(
    join(plugin, ".codex-plugin", "plugin.json"),
    '{"name":"codex-local-memory"}\n',
  );
  await writeFile(
    join(plugin, "hooks", "hooks.json"),
    '{"hooks":{"SessionStart":[],"UserPromptSubmit":[],"Stop":[]}}\n',
  );
  return project;
}

function fakeCommand(calls: string[][]): CommandRunner {
  return async (executable, arguments_) => {
    calls.push([executable, ...arguments_]);
    if (executable === "codex" && arguments_[0] === "--version") {
      return { stdout: "codex-cli 0.148.0-alpha.9\n", stderr: "" };
    }
    return { stdout: "{}\n", stderr: "" };
  };
}

test("installer copies a self-contained runtime and uninstall keeps data", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-install-"));
  const home = join(root, "home");
  const project = await projectFixture(root);
  const calls: string[][] = [];
  const result = await installProduct({
    home,
    projectRoot: project,
    nodeExecutable: "/opt/codex-local/node",
    platform: "darwin",
    command: fakeCommand(calls),
    socketReady: async () => undefined,
  });

  const installedCli = join(result.layout.runtimeDirectory, "cli.js");
  const wrapper = join(result.layout.pluginDirectory, "bin", "codex-local-memory-hook");
  assert.match(
    await readFile(wrapper, "utf8"),
    /\$PLUGIN_ROOT\/runtime\/hook-cli\.js/u,
  );
  assert.match(await readFile(wrapper, "utf8"), /\/opt\/codex-local\/node/u);
  assert.match(await readFile(result.layout.launchAgent, "utf8"), /KeepAlive/u);
  assert.match(
    await readFile(result.layout.marketplaceFile, "utf8"),
    /codex-local-memory-local/u,
  );
  assert.ok(
    calls.some((call) =>
      call.join(" ").includes("plugin add codex-local-memory@codex-local-memory-local"),
    ),
  );

  await rm(project, { recursive: true });
  await access(installedCli);
  const database = join(result.layout.dataDirectory, "memory.sqlite");
  await writeFile(database, "keep-me");
  await uninstallProduct({
    home,
    platform: "darwin",
    command: fakeCommand(calls),
  });
  await assert.rejects(access(installedCli));
  assert.equal(await readFile(database, "utf8"), "keep-me");
});

test("installer rejects unknown full CLI versions and MemoraX coexistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-install-"));
  const project = await projectFixture(root);
  const unsupported: CommandRunner = async () => ({
    stdout: "codex-cli 0.148.0-alpha.10\n",
    stderr: "",
  });
  await assert.rejects(
    installProduct({
      home: join(root, "unsupported-home"),
      projectRoot: project,
      platform: "darwin",
      command: unsupported,
    }),
    /unsupported_codex_cli_version/u,
  );

  const conflictHome = join(root, "conflict-home");
  await mkdir(
    join(
      conflictHome,
      ".codex",
      ".memorax-code",
      "plugins",
      "memorax-code-codex-adapter",
    ),
    { recursive: true },
  );
  await assert.rejects(
    installProduct({
      home: conflictHome,
      projectRoot: project,
      platform: "darwin",
      command: fakeCommand([]),
    }),
    /memorax_adapter_conflict/u,
  );
});
