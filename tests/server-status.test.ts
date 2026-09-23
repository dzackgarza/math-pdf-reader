import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig } from "../src/server/config";

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;

test("status reports a ready storage contract for an existing writable root", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-status-"));
  const app = createApp({ root, version: "0.1.0" });

  const response = await app.request(`${origin}/status`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    backend_url: origin,
    root,
    service: { name: "pdf-bucket", version: "0.1.0" },
    storage: { root_exists: true, root_writable: true },
    capabilities: { capture: true },
    ready: true,
  });
  expect(readdirSync(root)).toEqual([]);
});

test("status reports a missing root as not ready without creating it", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pdf-bucket-status-"));
  const root = join(parent, "missing-root");
  const app = createApp({ root, version: "0.1.0" });

  const response = await app.request(`${origin}/status`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    backend_url: origin,
    root,
    service: { name: "pdf-bucket", version: "0.1.0" },
    storage: { root_exists: false, root_writable: false },
    capabilities: { capture: false },
    ready: false,
  });
  expect(readdirSync(parent)).toEqual([]);
});
