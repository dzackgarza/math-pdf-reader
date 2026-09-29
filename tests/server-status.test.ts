import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

function bucket(root: string) {
  return serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
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
    extensions: { chrome: null, firefox: null },
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
    extensions: { chrome: null, firefox: null },
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

test("a provisioned bucket reports its extension builds and offers Firefox the signed one", async () => {
  const extensions = mkdtempSync(join(tmpdir(), "pdf-bucket-extensions-"));
  mkdirSync(join(extensions, "chrome-mv3"));
  mkdirSync(join(extensions, "firefox-mv2"));
  writeFileSync(join(extensions, "chrome-mv3/manifest.json"), JSON.stringify({ version: "1.0.7" }));
  writeFileSync(
    join(extensions, "firefox-mv2/manifest.json"),
    JSON.stringify({
      version: "1.0.5",
      browser_specific_settings: { gecko: { id: "pdf-bucket@example.org" } },
    }),
  );
  const signed = new TextEncoder().encode("the signed package");
  writeFileSync(join(extensions, "firefox.xpi"), signed);
  const app = await serveBucket({
    root: mkdtempSync(join(tmpdir(), "pdf-bucket-status-")),
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    extensions,
  });

  const status = await (await app.request("/status")).json();
  const updates = await (await app.request("/extension/updates.json")).json();
  const firefoxPackage = await app.request("/extension/firefox.xpi");

  expect(status.extensions).toEqual({ chrome: "1.0.7", firefox: "1.0.5" });
  expect(updates).toEqual({
    addons: {
      "pdf-bucket@example.org": {
        updates: [
          {
            version: "1.0.5",
            update_link: `${app.origin}/extension/firefox.xpi`,
            update_hash: `sha256:${new Bun.CryptoHasher("sha256").update(signed).digest("hex")}`,
          },
        ],
      },
    },
  });
  expect(firefoxPackage.headers.get("content-type")).toBe("application/x-xpinstall");
  expect(new Uint8Array(await firefoxPackage.arrayBuffer())).toEqual(signed);
});

test("a bucket given no signed Firefox build refuses Firefox's update check", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-status-")));

  const response = await app.request("/extension/updates.json");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      kind: "unknown_extension_build",
      message: expect.stringContaining("no signed Firefox build"),
    },
  });
});
