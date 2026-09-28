// Item titles at capture and on "Retrieve metadata": the server asks Zotero's local write API
// to resolve the item's URL without saving anything. Zotero here is a replay of that API's
// answers, recorded from a live Zotero (tests/fixtures/zotero), so the real store and the real
// server take part and no request leaves the machine.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { CaptureResponseSchema } from "../src/contract/capture";
import {
  FolderImportResponseSchema,
  LibraryPayloadSchema,
  RetrieveMetadataResponseSchema,
} from "../src/contract/library";
import { type Bucket, closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const fixtures = join(import.meta.dir, "fixtures");
const arxivPdf = readFileSync(join(fixtures, "arxiv-2609.21174v1.pdf"));
const lectureNotes = readFileSync(join(fixtures, "lecture-notes.pdf"));
const resolvedArxiv = readFileSync(join(fixtures, "zotero/resolve-arxiv.json"), "utf8");
const unidentified = readFileSync(join(fixtures, "zotero/resolve-unidentified.json"), "utf8");

const arxiv = {
  pdf: "https://arxiv.org/pdf/2609.21174v1",
  source: "https://arxiv.org/abs/2609.21174v1",
};

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
    if (request.method !== "POST" || new URL(request.url).pathname !== "/write") {
      return new Response("not the write API", { status: 404 });
    }
    const { url } = ResolveRequestSchema.parse(await request.json());
    resolved.push(url);
    const headers = { "Content-Type": "application/json" };
    if (url === arxiv.pdf) {
      return new Response(resolvedArxiv, { headers });
    }
    return new Response(unidentified, { status: 422, headers });
  },
});
afterAll(() => zotero.stop(true));
const zoteroDown = closedPortUrl();

function bucket(root: string, zoteroUrl: string) {
  return serveBucket({ root, zoteroUrl, extractionsManifest: EXTRACTIONS_MANIFEST });
}

// Captures BYTES as the extension does and answers the capture response.
async function capture(
  app: Bucket,
  bytes: Buffer,
  filename: string,
  urls: { pdf: string; source: string | null },
  titleHint: string,
) {
  const form = new FormData();
  form.set("pdf", new File([new Uint8Array(bytes)], filename, { type: "application/pdf" }));
  form.set("pdf_url", urls.pdf);
  if (urls.source !== null) {
    form.set("source_url", urls.source);
  }
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

const notes = {
  pdf: "https://www.math.example.edu/~author/notes.pdf",
  source: "https://www.math.example.edu/~author/",
};

test("an arXiv capture takes the title, authors, year and abstract Zotero resolves for its PDF URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  const captured = await capture(
    await bucket(root, zotero.url.origin),
    arxivPdf,
    "2609.21174v1",
    arxiv,
    "View PDF",
  );

  expect(resolved).toContain(arxiv.pdf);
  expect(captured.metadata).toEqual({
    status: "resolved",
    method: "pdf_recognition",
    title: "On The Cyclicity of Algebraic Lattices",
  });
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

test("with Zotero down, a capture succeeds and falls back to the PDF's own title, then to the hint", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-titles-")), zoteroDown);
  const withMetadata = await capture(app, arxivPdf, "2609.21174v1", arxiv, "View PDF");
  await capture(app, lectureNotes, "notes.pdf", notes, "Lecture notes on lattices");

  expect(withMetadata.metadata?.status).toBe("error");
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
  await capture(await bucket(root, zoteroDown), arxivPdf, "2609.21174v1", arxiv, "View PDF");
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

test("Retrieve metadata with Zotero down reports the error and keeps the title the item had", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  await capture(await bucket(root, zotero.url.origin), arxivPdf, "2609.21174v1", arxiv, "View PDF");

  const retrieved = await retrieve(await bucket(root, zoteroDown), "2609.21174v1");

  expect(retrieved.outcome.status).toBe("error");
  expect([retrieved.item.title, retrieved.item.titleSource]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "resolver",
  ]);
});

test("Retrieve metadata on a source no Zotero method identifies reports each method's attempt; an unknown key is not found", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-titles-")), zotero.url.origin);
  await capture(app, lectureNotes, "notes.pdf", notes, "Lecture notes on lattices");

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
  expect(file.metadata.status).toBe("unidentified");
  expect(resolved).toContain(`${app.origin}/pdf/${file.key}.pdf`);
});

test("an existing PDF's capture reports no metadata outcome", async () => {
  const app = await bucket(mkdtempSync(join(tmpdir(), "pdf-bucket-titles-")), zoteroDown);
  const first = await capture(app, lectureNotes, "notes.pdf", { pdf: arxiv.pdf, source: null }, "View PDF");

  const again = await capture(
    app,
    lectureNotes,
    "other-name.pdf",
    { pdf: "https://mirror.example.org/notes.pdf", source: null },
    "View PDF",
  );

  expect([again.existing, again.key, again.metadata]).toEqual([true, first.key, null]);
});
