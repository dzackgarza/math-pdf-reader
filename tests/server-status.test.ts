import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

const config = loadAppConfig(CONFIG_PATH);

function bucket(root: string) {
  return serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
}

test("status reports a ready storage contract for an existing writable root", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-status-"));
  const app = await bucket(root);

  const response = await app.request("/status");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    backend_url: app.origin,
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
  const app = await bucket(root);

  const response = await app.request("/status");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    backend_url: app.origin,
    root,
    service: { name: "pdf-bucket", version: "0.1.0" },
    storage: { root_exists: false, root_writable: false },
    capabilities: { capture: false },
    ready: false,
  });
  expect(readdirSync(parent)).toEqual([]);
});
