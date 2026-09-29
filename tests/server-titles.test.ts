// Item titles at capture and on "Retrieve metadata": the server checks Zotero's health, then
// asks Zotero's local write API to resolve the item's URL without saving anything. A new PDF runs
// Retrieve metadata in the background after its capture answered, and its outcome is a
// `metadata` event. Zotero here is a replay of that API's answers, recorded from a live Zotero
// (tests/fixtures/zotero), so the real store and the real server take part and no request leaves
// the machine.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { CaptureResponseSchema, MetadataEventSchema } from "../src/contract/capture";
import {
  FolderImportResponseSchema,
  LibraryPayloadSchema,
  RetrieveMetadataResponseSchema,
} from "../src/contract/library";
import {
  type Bucket,
  closedPortUrl,
  EXTRACTIONS_MANIFEST,
  serveBucket,
  subscribeEvents,
} from "./bucket";

const fixtures = join(import.meta.dir, "fixtures");
const arxivPdf = readFileSync(join(fixtures, "arxiv-2609.21174v1.pdf"));
const lectureNotes = readFileSync(join(fixtures, "lecture-notes.pdf"));
const resolvedArxiv = readFileSync(join(fixtures, "zotero/resolve-arxiv.json"), "utf8");
const unidentified = readFileSync(join(fixtures, "zotero/resolve-unidentified.json"), "utf8");
const version = readFileSync(join(fixtures, "zotero/version.json"), "utf8");

const arxiv = "https://arxiv.org/pdf/2609.21174v1";

const ResolveRequestSchema = z.strictObject({
  operation: z.literal("resolve_url"),
  url: z.url(),
});

// The URLs the bucket asked Zotero to resolve, in order.
const resolved: string[] = [];
// Zotero identifies the arXiv PDF by recognizing it; no method identifies any other URL.
const zotero = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const headers = { "Content-Type": "application/json" };
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/version") {
      return new Response(version, { headers });
    }
    if (request.method !== "POST" || pathname !== "/write") {
      return new Response("not the write API", { status: 404 });
    }
    const { url } = ResolveRequestSchema.parse(await request.json());
    resolved.push(url);
    if (url === arxiv) {
      return new Response(resolvedArxiv, { headers });
    }
    return new Response(unidentified, { status: 422, headers });
  },
});
afterAll(() => zotero.stop(true));
const zoteroDown = closedPortUrl();
const NOT_RUNNING = {
  status: "zotero_unavailable",
  message: "Zotero is not running: start Zotero",
} as const;

// A bucket over ROOT with Zotero at ZOTERO_URL, subscribed to its events.
async function bucket(root: string, zoteroUrl: string) {
  const app = await serveBucket({ root, zoteroUrl, extractionsManifest: EXTRACTIONS_MANIFEST });
  const events = await subscribeEvents(app);
  return { ...app, metadata: () => events.next("metadata", MetadataEventSchema) };
}

type Subscribed = Awaited<ReturnType<typeof bucket>>;

// Captures BYTES as the extension does and answers the capture response.
async function capture(
  app: Subscribed,
  bytes: Buffer,
  filename: string,
  pdfUrl: string,
  titleHint: string,
) {
  const form = new FormData();
  form.set("pdf", new File([new Uint8Array(bytes)], filename, { type: "application/pdf" }));
  form.set("pdf_url", pdfUrl);
  form.set("title_hint", titleHint);
  const response = await app.request("/capture-bytes", { method: "POST", body: form });
  expect(response.status).toBe(200);
  return CaptureResponseSchema.parse(await response.json());
}

async function item(app: Bucket, key: string) {
  const payload = LibraryPayloadSchema.parse(await (await app.request("/api/library")).json());
  const found = payload.items.find((candidate) => candidate.id === key);
  if (found === undefined) {
    throw new Error(`the library lists no item ${key}`);
  }
  return found;
}

async function retrieve(app: Bucket, key: string) {
  const response = await app.request(`/api/items/${key}/metadata`, { method: "POST" });
  expect(response.status).toBe(200);
  return RetrieveMetadataResponseSchema.parse(await response.json());
}

async function readerMeta(app: Bucket, key: string, name: string) {
  const { document } = parseHTML(await (await app.request(`/read/${key}`)).text());
  return [...document.querySelectorAll(`meta[name="${name}"]`)].map((meta) =>
    meta.getAttribute("content"),
  );
}

const ARXIV_AUTHORS = [
  "Maria Fernanda Zordan Bonini",
  "Robson Ricardo de Araujo",
  "Antonio Aparecido de Andrade",
  "Jéfferson Luiz Rocha Bastos",
];

const notes = "https://www.math.example.edu/~author/notes.pdf";

test("an arXiv capture takes the title, authors, year and abstract Zotero resolves for its PDF URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  const app = await bucket(root, zotero.url.origin);
  const captured = await capture(app, arxivPdf, "2609.21174v1", arxiv, "View PDF");

  expect(await app.metadata()).toEqual({
    key: captured.key,
    outcome: {
      status: "resolved",
      method: "pdf_recognition",
      title: "On The Cyclicity of Algebraic Lattices",
    },
  });
  expect(resolved).toContain(arxiv);
  // A fresh server over the same root: the metadata is read back from the stored PDF.
  const reread = await bucket(root, zoteroDown);
  const listed = await item(reread, "2609.21174v1");
  expect([listed.title, listed.titleSource]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "resolver",
  ]);
  expect(listed.provenance.title_hint).toBe("View PDF");
  expect(listed.authors).toEqual(ARXIV_AUTHORS);
  expect(listed.year).toBe(2026);
  expect(listed.abstract).toStartWith(
    "This work presents theoretical advances in the study of cyclic and quasi-cyclic lattices.",
  );
  expect(await readerMeta(reread, "2609.21174v1", "citation_title")).toEqual([
    "On The Cyclicity of Algebraic Lattices",
  ]);
  expect(await readerMeta(reread, "2609.21174v1", "citation_author")).toEqual(ARXIV_AUTHORS);
});

test("with Zotero down, a capture succeeds, reports that Zotero is not running, and falls back to the PDF's own title, then to the hint", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-titles-")), zoteroDown);
  await capture(app, arxivPdf, "2609.21174v1", arxiv, "View PDF");
  await capture(app, lectureNotes, "notes.pdf", notes, "Lecture notes on lattices");

  const outcomes = [await app.metadata(), await app.metadata()];
  expect(outcomes).toContainEqual({ key: "2609.21174v1", outcome: NOT_RUNNING });
  expect(outcomes).toContainEqual({ key: "notes", outcome: NOT_RUNNING });
  const fromPdf = await item(app, "2609.21174v1");
  const fromHint = await item(app, "notes");
  expect([fromPdf.title, fromPdf.titleSource]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "pdf-metadata",
  ]);
  expect([fromHint.title, fromHint.titleSource]).toEqual([
    "Lecture notes on lattices",
    "capture-hint",
  ]);
  // The arXiv PDF names its authors in its own metadata; the lecture notes name none.
  expect(fromPdf.authors).toEqual(ARXIV_AUTHORS);
  expect(fromHint.authors).toEqual([]);
});

test("Retrieve metadata resolves an item captured while Zotero was down", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  const offline = await bucket(root, zoteroDown);
  await capture(offline, arxivPdf, "2609.21174v1", arxiv, "View PDF");
  await offline.metadata();
  const online = await bucket(root, zotero.url.origin);

  const retrieved = await retrieve(online, "2609.21174v1");

  expect(retrieved.outcome).toEqual({
    status: "resolved",
    method: "pdf_recognition",
    title: "On The Cyclicity of Algebraic Lattices",
  });
  expect([retrieved.item.title, retrieved.item.titleSource, retrieved.item.year]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "resolver",
    2026,
  ]);
  expect(await item(online, "2609.21174v1")).toEqual(retrieved.item);
});

test("Retrieve metadata with Zotero down says to start Zotero and keeps the title the item had", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  const online = await bucket(root, zotero.url.origin);
  await capture(online, arxivPdf, "2609.21174v1", arxiv, "View PDF");
  await online.metadata();

  const retrieved = await retrieve(await bucket(root, zoteroDown), "2609.21174v1");

  expect(retrieved.outcome).toEqual(NOT_RUNNING);
  expect([retrieved.item.title, retrieved.item.titleSource]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "resolver",
  ]);
});

test("Retrieve metadata on a source no Zotero method identifies reports each method's attempt; an unknown key is not found", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-titles-")), zotero.url.origin);
  await capture(app, lectureNotes, "notes.pdf", notes, "Lecture notes on lattices");
  await app.metadata();

  const retrieved = await retrieve(app, "notes");

  expect(retrieved.outcome).toEqual({
    status: "unidentified",
    attempts: [
      {
        method: "pdf_recognition",
        outcome: "no_match",
        message: "the recognizer produced no parent item (see the Zotero debug log)",
      },
      { method: "identifier", outcome: "no_match", message: "no DOI, ISBN or arXiv ID found" },
    ],
  });
  expect([retrieved.item.title, retrieved.item.titleSource]).toEqual([
    "Lecture notes on lattices",
    "capture-hint",
  ]);
  expect((await app.request(`/api/items/missing/metadata`, { method: "POST" })).status).toBe(404);
});

test("a folder import asks Zotero to resolve the bucket's own URL for the stored PDF", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-titles-")), zotero.url.origin);
  const folder = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-folder-"));
  copyFileSync(join(fixtures, "lecture-notes.pdf"), join(folder, "notes.pdf"));

  const response = await app.request("/api/import-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });

  expect(response.status).toBe(200);
  const [file] = FolderImportResponseSchema.parse(await response.json()).files;
  if (file?.status !== "stored") {
    throw new Error(`the folder's PDF was not stored: ${JSON.stringify(file)}`);
  }
  const { key, outcome } = await app.metadata();
  expect([key, outcome.status]).toEqual([file.key, "unidentified"]);
  expect(resolved).toContain(`${app.origin}/pdf/${file.key}.pdf`);
});

test("an existing PDF's capture runs no Retrieve metadata", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-titles-")), zoteroDown);
  const first = await capture(app, lectureNotes, "notes.pdf", arxiv, "View PDF");

  const again = await capture(
    app,
    lectureNotes,
    "other-name.pdf",
    "https://mirror.example.org/notes.pdf",
    "View PDF",
  );

  const third = await capture(app, arxivPdf, "2609.21174v1", arxiv, "View PDF");

  expect([again.existing, again.key]).toEqual([true, first.key]);
  // The first capture's outcome, then the third's: the repeat ran nothing in between.
  expect((await app.metadata()).key).toBe(first.key);
  expect((await app.metadata()).key).toBe(third.key);
});
