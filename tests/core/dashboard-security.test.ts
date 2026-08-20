import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DashboardServer,
  dashboardAssetsDirectory,
} from "../../src/dashboard/server.js";
import { MemoryDatabase } from "../../src/db/database.js";
import { ModelManager } from "../../src/model/manager.js";
import { MemoryKeyProvider } from "../helpers/memory-key.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("P0-04 dashboard bootstrap is one-time and writes require Origin plus CSRF", async () => {
  const root = await mkdtemp(join(tmpdir(), "clm-dashboard-"));
  const database = new MemoryDatabase(join(root, "memory.sqlite"));
  const port = await unusedPort();
  const dashboard = new DashboardServer(
    database,
    new ModelManager(database, new MemoryKeyProvider()),
    {
      port,
      assetsDirectory: new URL("../../assets/dashboard", import.meta.url).pathname,
    },
  );
  await dashboard.start();
  try {
    const bootstrapUrl = new URL(dashboard.issueBootstrapUrl());
    const token = bootstrapUrl.hash.slice(1);
    const page = await fetch(dashboard.origin);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /object-src 'none'/u,
    );

    const bootstrap = await fetch(`${dashboard.origin}/api/bootstrap`, {
      method: "POST",
      headers: {
        origin: dashboard.origin,
        "content-type": "application/json",
        "x-codex-local-bootstrap": "1",
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const { csrf } = (await bootstrap.json()) as { csrf: string };

    const reused = await fetch(`${dashboard.origin}/api/bootstrap`, {
      method: "POST",
      headers: {
        origin: dashboard.origin,
        "content-type": "application/json",
        "x-codex-local-bootstrap": "1",
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(reused.status, 401);

    const maliciousOrigin = await fetch(`${dashboard.origin}/api/model/pause`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
        "x-codex-local-csrf": csrf,
      },
      body: "{}",
    });
    assert.equal(maliciousOrigin.status, 403);

    const missingCsrf = await fetch(`${dashboard.origin}/api/model/pause`, {
      method: "POST",
      headers: {
        cookie,
        origin: dashboard.origin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);

    const valid = await fetch(`${dashboard.origin}/api/model/pause`, {
      method: "POST",
      headers: {
        cookie,
        origin: dashboard.origin,
        "content-type": "application/json",
        "x-codex-local-csrf": csrf,
      },
      body: "{}",
    });
    assert.equal(valid.status, 200);
  } finally {
    await dashboard.stop();
    database.close();
  }
});

test("dashboard exposes exactly four product pages without unsafe DOM APIs", async () => {
  const root = new URL("../../assets/dashboard/", import.meta.url);
  const page = await readFile(new URL("index.html", root), "utf8");
  const script = (
    await Promise.all(
      ["app.js", "reviews.js", "bootstrap.js"].map((name) =>
        readFile(new URL(name, root), "utf8"),
      ),
    )
  ).join("\n");
  for (const name of ["reviews", "memories", "model", "health"]) {
    assert.match(page, new RegExp(`data-page="${name}"`, "u"));
  }
  assert.doesNotMatch(script, /innerHTML/u);
  assert.doesNotMatch(script, /serviceWorker/u);
  assert.doesNotMatch(script, /codex-local\//u);
  assert.doesNotMatch(script, /禁用模型思考|disable_thinking/u);
  assert.doesNotMatch(script, /允许 HTTP loopback 本地模型/u);
  assert.doesNotMatch(script, /外发本轮 Prompt|外发最终回答/u);
  assert.match(script, /保存并测试/u);
  assert.match(script, /关闭自动抽取/u);
  assert.match(script, /冲突不会自动选择胜者/u);
  assert.match(script, /element\("strong", repository\.displayName\)/u);
  assert.doesNotMatch(page, /data-page="(?:home|settings|export)"/u);
});

test("installed dashboard asset paths decode Application Support spaces", () => {
  assert.equal(
    dashboardAssetsDirectory(
      "file:///Users/demo/Library/Application%20Support/codex-local-memory/runtime/dashboard/server.js",
    ),
    "/Users/demo/Library/Application Support/codex-local-memory/runtime/assets/dashboard",
  );
});
