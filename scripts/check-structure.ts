import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SOURCE_ROOT = join(ROOT, "src");
const MAX_SOURCE_LINES = 340;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:ts|js)$/u.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

const failures: string[] = [];
for (const path of await sourceFiles(SOURCE_ROOT)) {
  const content = await readFile(path, "utf8");
  const name = relative(ROOT, path);
  const lines = content.split(/\r?\n/u).length;
  if (lines > MAX_SOURCE_LINES) {
    failures.push(`${name} has ${lines} lines (max ${MAX_SOURCE_LINES})`);
  }
  if (
    path !== join(SOURCE_ROOT, "db", "core.ts") &&
    content.includes('"node:sqlite"')
  ) {
    failures.push(`${name} bypasses the SQLite single-entry module`);
  }
  if (
    content.includes('from "node:child_process"') &&
    path !== join(SOURCE_ROOT, "macos", "command-runner.ts")
  ) {
    failures.push(`${name} bypasses the allow-listed command runner`);
  }
  if (/exec(?:File)?\([^\n]*["']git["']/u.test(content)) {
    failures.push(`${name} may execute the git binary`);
  }
  if (
    /\bfetch\s*\(/u.test(content) &&
    path !== join(SOURCE_ROOT, "model", "client.ts")
  ) {
    failures.push(`${name} performs an unapproved outbound HTTP request`);
  }
  if (
    /payload\.(?:reasoning|last_assistant_message|token_count|world_state)/u.test(
      content,
    )
  ) {
    failures.push(`${name} accesses a forbidden rollout field`);
  }
}

for (const directory of [
  join(ROOT, "tests"),
  join(ROOT, "scripts"),
  join(ROOT, "assets", "dashboard"),
]) {
  for (const path of await sourceFiles(directory)) {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u).length;
    if (lines > 360) {
      failures.push(`${relative(ROOT, path)} has ${lines} lines (max 360)`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}
