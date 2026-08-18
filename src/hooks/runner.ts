import { HOOK_TIMEOUT_MS } from "../constants.js";
import { runtimePaths } from "../paths.js";
import { callSidecar } from "./ipc-client.js";

export type HookName = "session-start" | "user-prompt-submit" | "stop";

export interface HookInput {
  session_id?: unknown;
  turn_id?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  transcript_path?: unknown;
}

export interface HookRunOptions {
  socketPath?: string;
  input?: HookInput;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("missing_hook_field");
  }
  return value;
}

async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new Error("hook_input_too_large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid_hook_input");
  }
  return parsed as HookInput;
}

export async function runHook(
  name: HookName,
  options: HookRunOptions = {},
): Promise<void> {
  const stdout = options.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = options.stderr ?? ((value: string) => process.stderr.write(value));
  if (name === "stop") stdout('{"continue":true}\n');
  try {
    const input = options.input ?? (await readHookInput());
    const sessionId = stringField(input.session_id);
    const cwd = stringField(input.cwd);
    const socketPath = options.socketPath ?? runtimePaths().socket;

    if (name === "session-start") {
      await callSidecar(
        socketPath,
        { type: "session_start", client: "codex", session_id: sessionId, cwd },
        HOOK_TIMEOUT_MS.sessionStart,
      );
      return;
    }

    if (name === "stop") {
      await callSidecar(
        socketPath,
        {
          type: "stop",
          client: "codex",
          session_id: sessionId,
          turn_id: stringField(input.turn_id),
          transcript_path: stringField(input.transcript_path),
          cwd,
        },
        HOOK_TIMEOUT_MS.stop,
      );
      return;
    }

    const response = await callSidecar(
      socketPath,
      {
        type: "recall",
        client: "codex",
        session_id: sessionId,
        turn_id: stringField(input.turn_id),
        cwd,
        prompt: stringField(input.prompt),
      },
      HOOK_TIMEOUT_MS.userPromptSubmit,
    );
    if (response.ok && response.additional_context) {
      stdout(
        `${JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: response.additional_context,
          },
        })}\n`,
      );
    }
  } catch {
    // All hooks are fail-open. Never print prompt, answer, paths, or socket errors.
    stderr(`codex-local-memory: ${name} unavailable\n`);
  }
}
