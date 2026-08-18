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
    await runMacosCommand(
      "/usr/bin/expect",
      ["-c", keychainWriteScript()],
      `${value}\n`,
    );
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

function keychainWriteScript(): string {
  return `
log_user 0
set timeout 10
if {[gets stdin secret] < 0} { exit 2 }
spawn /usr/bin/security add-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -U -w
set prompts 0
expect {
  -re {password.*:} {
    incr prompts
    send -- "$secret\\r"
    exp_continue
  }
  timeout { exit 3 }
  eof {}
}
if {$prompts < 1} { exit 4 }
set result [wait]
exit [lindex $result 3]
`;
}
