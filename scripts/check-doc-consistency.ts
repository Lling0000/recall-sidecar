import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_REFERENCE,
  KEYCHAIN_SERVICE,
  LAUNCHD_LABEL,
  PLUGIN_DIRECTORY_NAME,
  SUPPORTED_NODE_RANGE,
  TESTED_CODEX_CLI_VERSIONS,
} from "../src/constants.js";
import { CONSOLIDATION_SCHEMA } from "../src/model/consolidation-contract.js";
import { GATE_SCHEMA, REFINER_SCHEMA } from "../src/model/session-contract.js";

const root = new URL("../", import.meta.url).pathname;
const [spec, agents, packageText, hooksText, pluginText] = await Promise.all([
  readFile(join(root, "Company-Agent-Memory-Implementation-Spec.md"), "utf8"),
  readFile(join(root, "AGENTS.md"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "plugin", PLUGIN_DIRECTORY_NAME, "hooks", "hooks.json"), "utf8"),
  readFile(
    join(root, "plugin", PLUGIN_DIRECTORY_NAME, ".codex-plugin", "plugin.json"),
    "utf8",
  ),
]);

const failures: string[] = [];
const packageJson = JSON.parse(packageText) as { engines?: { node?: string } };
const hooks = JSON.parse(hooksText) as { hooks: Record<string, unknown> };
const plugin = JSON.parse(pluginText) as { name?: string };

assertEqual(packageJson.engines?.node, SUPPORTED_NODE_RANGE, "Node engine range");
assertEqual(plugin.name, PLUGIN_DIRECTORY_NAME, "plugin name");
assertEqual(
  Object.keys(hooks.hooks).sort().join(","),
  ["SessionStart", "Stop", "UserPromptSubmit"].sort().join(","),
  "Hook event set",
);
if (!hooksText.includes("$PLUGIN_ROOT"))
  failures.push("Hook commands must use $PLUGIN_ROOT");

for (const value of [
  TESTED_CODEX_CLI_VERSIONS[0],
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_REFERENCE,
  LAUNCHD_LABEL,
  PLUGIN_DIRECTORY_NAME,
]) {
  if (!spec.includes(value) || !agents.includes(value)) {
    failures.push(`Spec/AGENTS mismatch for ${value}`);
  }
}

assertEqual(
  GATE_SCHEMA.properties.selected_turn_ids.maxItems.toString(),
  "8",
  "Gate selection limit",
);
assertEqual(
  REFINER_SCHEMA.properties.edits.maxItems.toString(),
  "8",
  "Refiner edit limit",
);
assertEqual(
  CONSOLIDATION_SCHEMA.properties.suggestions.maxItems.toString(),
  "8",
  "Consolidation suggestion limit",
);

const testDirectory = join(root, "tests", "core");
const testText = (
  await Promise.all(
    (
      await readdir(testDirectory)
    )
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => readFile(join(testDirectory, name), "utf8")),
  )
).join("\n");
for (let number = 1; number <= 25; number += 1) {
  const id = `P0-${String(number).padStart(2, "0")}`;
  if (!testText.includes(id)) failures.push(`${id} has no explicit core test mapping`);
}

for (const path of ["README.md", "docs/architecture.md", "docs/installation.md"]) {
  const content = await readFile(join(root, path), "utf8");
  if (content.includes("dangerously-bypass-hook-trust")) {
    failures.push(`${path} documents a forbidden trust bypass`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}

function assertEqual(
  actual: string | undefined,
  expected: string,
  label: string,
): void {
  if (actual !== expected)
    failures.push(`${label}: expected ${expected}, got ${actual}`);
}
