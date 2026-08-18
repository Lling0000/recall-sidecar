import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from "../constants.js";
import type { ApiKeyProvider } from "../model/types.js";
import { runMacosCommand } from "./command-runner.js";

export class MacKeychain implements ApiKeyProvider {
  async get(): Promise<string | null> {
    try {
      const result = await runMacosCommand("/usr/bin/security", [
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async set(value: string): Promise<void> {
    if (!value) throw new Error("api_key_required");
    await runMacosCommand("/usr/bin/security", [
      "add-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      value,
      "-U",
    ]);
  }

  async delete(): Promise<void> {
    try {
      await runMacosCommand("/usr/bin/security", [
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
    } catch {
      // A missing entry is already in the desired state.
    }
  }
}
