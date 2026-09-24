// Source checks, mirror URLs and rebuilding lost PDFs, through the real server and store
// against a local publisher whose responses the tests change.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import { readIndexExport } from "../src/server/indexExport";
import {
  ApiErrorSchema,
  type BucketItem,
  LibraryPayloadSchema,
  RebuildOutcomeSchema,
} from "../src/server/libraryContract";
import { RESOLVERS_MANIFEST } from "../src/server/send";
import { recordMetadata } from "../src/server/store";

setDefaultTimeout(30_000);

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));
const lectureNotes = fixture("lecture-notes.pdf");
const problemSet = fixture("problem-set.pdf");

// The publisher: what each path serves right now; a path with nothing serves 404.
const served = new Map<string, Uint8Array<ArrayBuffer>>();
const publisher = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const bytes = served.get(new URL(request.url).pathname);
    return bytes === undefined
      ? new Response("not found", { status: 404 })
      : new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
  },
});
afterAll(() => publisher.stop(true));
const at = (path: string) => new URL(path, publisher.url).href;

function bucket(indexExport: string | null) {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-sources-"));
  const app = createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport,
  });
  const request = (method: string, path: string, body?: object) =>
    app.request(`${origin}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const capture = async (bytes: Uint8Array<ArrayBuffer>, key: string, pdfUrl: string) => {
    const form = new FormData();
    form.set("pdf", new File([bytes], `${key}.pdf`, { type: "application/pdf" }));
    form.set("pdf_url", pdfUrl);
    form.set("source_url", at("/teaching.html"));
    form.set("title_hint", `Notes ${key}`);
    const response = await app.request(`${origin}/capture-bytes`, { method: "POST", body: form });
    expect(response.status).toBe(200);
  };
  const library = async () =>
    LibraryPayloadSchema.parse(await (await request("GET", "/api/library")).json());
  const item = async (key: string): Promise<BucketItem> => {
    const found = (await library()).items.find((candidate) => candidate.id === key);
    if (found === undefined) {
      throw new Error(`the library lists no item ${key}`);
    }
    return found;
  };
  return { root, request, capture, library, item };
}

test("Verify records whether the PDF URL and each mirror still serve the captured bytes", async () => {
  served.set("/notes/verified.pdf", lectureNotes);
  served.set("/mirror/verified.pdf", lectureNotes);
  const { request, capture, item } = bucket(null);
  await capture(lectureNotes, "verified", at("/notes/verified.pdf"));
  expect((await item("verified")).sourceCheck).toEqual({ status: "unchecked" });

  expect(
    (await request("POST", "/api/items/verified/mirrors", { url: at("/mirror/verified.pdf") }))
      .status,
  ).toBe(200);
  await request("POST", "/api/items/verified/mirrors", { url: at("/gone/verified.pdf") });
  expect((await request("POST", "/api/items/verified/verify")).status).toBe(200);
  const checked = await item("verified");
  expect(checked.sourceCheck).toMatchObject({ status: "accessible" });
  expect(checked.mirrors.map((mirror) => [mirror.url, mirror.check.status])).toEqual([
    [at("/mirror/verified.pdf"), "accessible"],
    [at("/gone/verified.pdf"), "dead"],
  ]);

  served.set("/notes/verified.pdf", problemSet);
  await request("POST", "/api/items/verified/verify");
  expect((await item("verified")).sourceCheck).toMatchObject({ status: "changed" });
  served.delete("/notes/verified.pdf");
  await request("POST", "/api/items/verified/verify");
  expect((await item("verified")).sourceCheck).toMatchObject({
    status: "dead",
    detail: "HTTP 404",
  });

  const removed = await request(
    "DELETE",
    `/api/items/verified/mirrors?url=${encodeURIComponent(at("/gone/verified.pdf"))}`,
  );
  expect(removed.status).toBe(200);
  expect((await item("verified")).mirrors.map((mirror) => mirror.url)).toEqual([
    at("/mirror/verified.pdf"),
  ]);
  const notUrl = await request("POST", "/api/items/verified/mirrors", { url: "not a url" });
  expect(notUrl.status).toBe(400);
  expect(ApiErrorSchema.parse(await notUrl.json()).error.kind).toBe("invalid_request");
  expect((await request("POST", "/api/items/missing/verify")).status).toBe(404);
});

test("an item the export holds whose PDF is gone needs re-fetching; Rebuild restores it from the PDF URL or a mirror", async () => {
  served.set("/notes/kept-url.pdf", lectureNotes);
  served.set("/mirror/moved.pdf", problemSet);
  const exportFile = join(mkdtempSync(join(tmpdir(), "pdf-bucket-sources-export-")), "index.json");
  const { root, request, capture, library, item } = bucket(exportFile);
  await capture(lectureNotes, "kept-url", at("/notes/kept-url.pdf"));
  await capture(problemSet, "moved", at("/notes/moved.pdf"));
  await capture(lectureNotes, "lost", at("/gone/lost.pdf"));
  await recordMetadata(root, "kept-url", "Integral Lattices", "resolver", ["Maryna Viazovska"]);
  await request("POST", "/api/items/moved/mirrors", { url: at("/mirror/moved.pdf") });
  // The export is written after each change; wait for the one that holds the mirror.
  let exported = await readIndexExport(exportFile).catch(() => null);
  while (exported?.items.find((entry) => entry.key === "moved")?.filing.mirrors.length !== 1) {
    await Bun.sleep(50);
    exported = await readIndexExport(exportFile).catch(() => null);
  }

  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-sources-away-"));
  for (const key of ["kept-url", "moved", "lost"]) {
    renameSync(join(root, `${key}.pdf`), join(away, `${key}.pdf`));
  }
  const missing = (await library()).missing;
  expect(missing.map((entry) => [entry.key, entry.title]).sort()).toEqual([
    ["kept-url", "Integral Lattices"],
    ["lost", "Notes lost"],
    ["moved", "Notes moved"],
  ]);

  const rebuild = async (key: string) =>
    RebuildOutcomeSchema.parse(await (await request("POST", `/api/items/${key}/rebuild`)).json());
  expect(await rebuild("kept-url")).toMatchObject({
    status: "restored",
    from: at("/notes/kept-url.pdf"),
  });
  expect(await rebuild("moved")).toMatchObject({
    status: "restored",
    from: at("/mirror/moved.pdf"),
  });
  expect(await rebuild("lost")).toMatchObject({ status: "unrestored" });

  const restored = await item("kept-url");
  expect([restored.title, restored.titleSource, restored.authors]).toEqual([
    "Integral Lattices",
    "resolver",
    ["Maryna Viazovska"],
  ]);
  expect((await item("moved")).mirrors.map((mirror) => mirror.url)).toEqual([
    at("/mirror/moved.pdf"),
  ]);
  expect((await library()).missing.map((entry) => entry.key)).toEqual(["lost"]);
});
