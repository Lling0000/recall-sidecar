import { LAUNCHD_LABEL } from "../constants.js";
import type { InstallLayout } from "./install-layout.js";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPlist(layout: InstallLayout, nodeExecutable: string): string {
  const cli = `${layout.runtimeDirectory}/cli.js`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeExecutable)}</string>
    <string>${xml(cli)}</string>
    <string>sidecar</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(layout.dataDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(layout.stdoutLog)}</string>
  <key>StandardErrorPath</key><string>${xml(layout.stderrLog)}</string>
</dict>
</plist>
`;
}
