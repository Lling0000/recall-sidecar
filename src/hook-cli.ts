#!/usr/bin/env node
import { type HookName, runHook } from "./hooks/runner.js";

const HOOK_NAMES = new Set<HookName>(["session-start", "user-prompt-submit", "stop"]);
const name = process.argv[2] as HookName;

if (HOOK_NAMES.has(name)) {
  await runHook(name);
} else {
  process.stderr.write("codex-local-memory: invalid hook event\n");
}
process.exitCode = 0;
