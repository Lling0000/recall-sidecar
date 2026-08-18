import { PLUGIN_DIRECTORY_NAME } from "../constants.js";
import { LOCAL_MARKETPLACE_NAME } from "./install-layout.js";

export function marketplaceManifest(): string {
  return `${JSON.stringify(
    {
      name: LOCAL_MARKETPLACE_NAME,
      interface: { displayName: "Recall Sidecar" },
      plugins: [
        {
          name: PLUGIN_DIRECTORY_NAME,
          source: {
            source: "local",
            path: `./plugins/${PLUGIN_DIRECTORY_NAME}`,
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function hookWrapper(nodeExecutable: string): string {
  const escaped = nodeExecutable.replaceAll("'", `'\\''`);
  return `#!/bin/sh\nexec '${escaped}' "$PLUGIN_ROOT/runtime/cli.js" hook "$1"\n`;
}
