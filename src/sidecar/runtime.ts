import { DashboardServer } from "../dashboard/server.js";
import { MemoryDatabase } from "../db/database.js";
import { RefineWorker } from "../jobs/refine-worker.js";
import { MacKeychain } from "../macos/keychain.js";
import { ModelManager } from "../model/manager.js";
import { runtimePaths } from "../paths.js";
import { SidecarService } from "./service.js";
import { SidecarSocketServer } from "./socket-server.js";

export async function runSidecar(): Promise<void> {
  const paths = runtimePaths();
  const database = new MemoryDatabase(paths.database);
  database.createBackup();
  const keychain = new MacKeychain();
  const worker = new RefineWorker(database, keychain);
  const dashboard = new DashboardServer(database, new ModelManager(database, keychain));
  const server = new SidecarSocketServer(
    paths.socket,
    new SidecarService(database, {
      onJobEnqueued: () => worker.wake(),
      issueDashboardBootstrap: () => dashboard.issueBootstrapUrl(),
    }),
  );
  await dashboard.start();
  await server.start();
  worker.wake();
  process.stderr.write("codex-local-memory: sidecar ready\n");

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await worker.idle();
  await server.stop();
  await dashboard.stop();
  database.close();
}
