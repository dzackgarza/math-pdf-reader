// Import URL and Add Folder through the real server and store: a local publisher serves a
// PDF, an abstract page naming its PDF with Highwire tags, and a page naming none.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ApiErrorSchema,
  FolderImportResponseSchema,
  ImportUrlResponseSchema,
  LibraryPayloadSchema,
} from "../src/contract/library";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import { RESOLVERS_MANIFEST } from "../src/server/send";

setDefaultTimeout(30_000);

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;
const fixtures = join(import.meta.dir, "fixtures");
const lectureNotes = new Uint8Array(readFileSync(join(fixtures, "lecture-notes.pdf")));
const problemSet = new Uint8Array(readFileSync(join(fixtures, "problem-set.pdf")));

const html = (body: string) =>
  new Response(`<!doctype html><html><head>${body}</head><body></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
const pdf = (bytes: Uint8Array<ArrayBuffer>) =>
  new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
const publisher = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/papers/lattices.pdf") {
      return pdf(lectureNotes);
    }
    if (path === "/pdf/2401.00001") {
      return pdf(problemSet);
    }
    if (path === "/abs/2401.00001") {
      return html(
        '<title>[2401.00001] Quadratic forms</title><meta name="citation_title" content="Problem Set on Quadratic Forms"><meta name="citation_pdf_url" content="/pdf/2401.00001">',
      );
    }
    if (path === "/blog.html") {
      return html("<title>A blog post</title>");
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => publisher.stop(true));
const at = (path: string) => new URL(path, publisher.url).href;

function bucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-import-"));
  const app = createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport: null,
  });
  const post = (path: string, body: object) =>
    app.request(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const items = async () =>
    LibraryPayloadSchema.parse(await (await app.request(`${origin}/api/library`)).json()).items;
  return { post, items };
}

test("Import URL stores a PDF URL as it is, and follows an abstract page's citation_pdf_url", async () => {
  const { post, items } = bucket();

  const direct = await post("/api/import-url", { url: at("/papers/lattices.pdf") });
  expect(direct.status).toBe(200);
  expect(ImportUrlResponseSchema.parse(await direct.json())).toEqual({
    key: "lattices",
    existing: false,
  });
  const fromPage = ImportUrlResponseSchema.parse(
    await (await post("/api/import-url", { url: at("/abs/2401.00001") })).json(),
  );
  expect(fromPage).toEqual({ key: "2401.00001", existing: false });

  const byKey = new Map((await items()).map((item) => [item.id, item]));
  expect(byKey.get("lattices")?.provenance).toMatchObject({
    pdf_url: at("/papers/lattices.pdf"),
    source_url: at("/papers/lattices.pdf"),
  });
  expect(byKey.get("2401.00001")?.provenance).toMatchObject({
    pdf_url: at("/pdf/2401.00001"),
    source_url: at("/abs/2401.00001"),
    title_hint: "Problem Set on Quadratic Forms",
  });

  const again = await post("/api/import-url", { url: at("/papers/lattices.pdf") });
  expect(ImportUrlResponseSchema.parse(await again.json())).toEqual({
    key: "lattices",
    existing: true,
  });
  const noPdf = await post("/api/import-url", { url: at("/blog.html") });
  expect(noPdf.status).toBe(422);
  expect(ApiErrorSchema.parse(await noPdf.json()).error.kind).toBe("no_pdf_at_url");
  const gone = await post("/api/import-url", { url: at("/gone.pdf") });
  expect(gone.status).toBe(422);
});

test("Add Folder stores every PDF in the folder with file URLs as provenance, once", async () => {
  const { post, items } = bucket();
  const folder = mkdtempSync(join(tmpdir(), "pdf-bucket-import-folder-"));
  copyFileSync(join(fixtures, "lecture-notes.pdf"), join(folder, "Lectures on Lattices.pdf"));
  copyFileSync(join(fixtures, "problem-set.pdf"), join(folder, "problem-set.pdf"));
  writeFileSync(join(folder, "notes.txt"), "not a PDF");

  const response = await post("/api/import-folder", { path: folder });
  expect(response.status).toBe(200);
  const imported = FolderImportResponseSchema.parse(await response.json());
  expect(imported.stored.sort()).toEqual(["Lectures on Lattices", "problem-set"]);
  expect(imported.existing).toEqual([]);

  const byKey = new Map((await items()).map((item) => [item.id, item]));
  expect(byKey.get("problem-set")?.provenance).toMatchObject({
    pdf_url: pathToFileURL(join(folder, "problem-set.pdf")).href,
    source_url: pathToFileURL(`${folder}/`).href,
    title_hint: "problem-set",
  });

  const again = FolderImportResponseSchema.parse(
    await (await post("/api/import-folder", { path: folder })).json(),
  );
  expect(again.stored).toEqual([]);
  expect(again.existing.sort()).toEqual(["Lectures on Lattices", "problem-set"]);
  // A folder item's file URL is checked on disk: present, then gone.
  const verified = LibraryPayloadSchema.parse(
    await (await post("/api/items/problem-set/verify", {})).json(),
  ).items.find((item) => item.id === "problem-set");
  expect(verified?.sourceCheck.status).toBe("accessible");
  renameSync(join(folder, "problem-set.pdf"), join(folder, "moved.pdf.bak"));
  const gone = LibraryPayloadSchema.parse(
    await (await post("/api/items/problem-set/verify", {})).json(),
  ).items.find((item) => item.id === "problem-set");
  expect(gone?.sourceCheck).toMatchObject({ status: "dead", detail: "no such file" });

  const notFolder = await post("/api/import-folder", { path: join(folder, "missing") });
  expect(notFolder.status).toBe(400);
});
