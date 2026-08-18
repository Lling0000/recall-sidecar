import { execFile } from "node:child_process";

const ALLOWED_EXECUTABLES = new Set(["/usr/bin/security", "/bin/launchctl", "codex"]);

export type CommandRunner = typeof runMacosCommand;

export async function runMacosCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== "darwin") throw new Error("macos_required");
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error("executable_not_allowed");
  }
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...arguments_],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error("macos_command_failed"));
        else resolve({ stdout, stderr });
      },
    );
  });
}
