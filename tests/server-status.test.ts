import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
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
    service: { name: "pdf-bucket", version: "1.0.0" },
    storage: { root_exists: true, root_writable: true },
    capabilities: { capture: true },
    ready: true,
    index_export: expect.objectContaining({ file: app.indexExport }),
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
    service: { name: "pdf-bucket", version: "1.0.0" },
    storage: { root_exists: false, root_writable: false },
    capabilities: { capture: false },
    ready: false,
    index_export: expect.objectContaining({ file: app.indexExport }),
  });
  expect(readdirSync(parent)).toEqual([]);
});

test("status reports a root this process cannot write as existing but not ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-status-"));
  chmodSync(root, 0o555);
  const app = await bucket(root);

  const response = await app.request("/status");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    storage: { root_exists: true, root_writable: false },
    capabilities: { capture: false },
    ready: false,
  });
});

test("status answers a failed check of the root with the operating system's error, not a storage state", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pdf-bucket-status-"));
  const root = join(parent, "looping-root");
  symlinkSync(root, root);
  const app = await bucket(root);

  const response = await app.request("/status");

  expect(response.status).toBe(500);
  // ELOOP is errno 40 on Linux: the message carries the operating system's own answer.
  expect(await response.json()).toEqual({
    error: { kind: "storage_check_failed", message: expect.stringContaining("(os error 40)") },
  });
});
