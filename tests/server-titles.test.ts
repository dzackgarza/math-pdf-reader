// Item titles at capture and on "Retrieve metadata": the resolver plugins run against a replay
// of the upstream responses they were captured from (tests/fixtures/resolvers), so the real
// resolver commands, the real store and the real server take part and no request leaves the
// machine.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { LibraryPayloadSchema, RetrieveMetadataResponseSchema } from "../src/contract/library";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import { RESOLVERS_MANIFEST } from "../src/server/send";

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;
const fixtures = join(import.meta.dir, "fixtures");
const arxivPdf = readFileSync(join(fixtures, "arxiv-2609.21174v1.pdf"));
const lectureNotes = readFileSync(join(fixtures, "lecture-notes.pdf"));

const CapturesSchema = z.strictObject({
  captured_at: z.string(),
  responses: z.array(
    z.strictObject({
      request: z.string(),
      live: z.url(),
      file: z.string(),
      content_type: z.string(),
    }),
  ),
});
const captures = CapturesSchema.parse(
  JSON.parse(readFileSync(join(fixtures, "resolvers/captures.json"), "utf8")),
);
const replay = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const entry = captures.responses.find(
      (candidate) => candidate.request === `${url.pathname}${url.search}`,
    );
    if (entry === undefined) {
      return new Response("not captured", { status: 404 });
    }
    return new Response(readFileSync(join(fixtures, "resolvers", entry.file)), {
      headers: { "Content-Type": entry.content_type },
    });
  },
});
afterAll(() => replay.stop(true));

const ShippedManifestSchema = z.strictObject({
  plugins: z.array(z.looseObject({ command: z.array(z.string()) })),
});

// The shipped resolver manifest with every plugin's upstream base URL replaced; its script
// paths become absolute because the copy lives outside the shipped manifest's directory.
function manifestWithUpstream(base: string): string {
  const shipped = ShippedManifestSchema.parse(JSON.parse(readFileSync(RESOLVERS_MANIFEST, "utf8")));
  const plugins = shipped.plugins.map((plugin) => {
    const [runner, script] = plugin.command;
    return { ...plugin, command: [runner, join(RESOLVERS_MANIFEST, "..", script ?? ""), base] };
  });
  const path = join(mkdtempSync(join(tmpdir(), "pdf-bucket-resolvers-")), "resolvers.json");
  writeFileSync(path, JSON.stringify({ plugins }));
  return path;
}

const replayManifest = manifestWithUpstream(`http://127.0.0.1:${replay.port}`);
// Nothing listens on port 9 (discard) on the loopback: every resolver request fails.
const deadManifest = manifestWithUpstream("http://127.0.0.1:9");

function bucket(root: string, resolversManifest: string) {
  return createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest,
    indexExport: null,
  });
}

async function capture(
  app: ReturnType<typeof createApp>,
  bytes: Buffer,
  filename: string,
  urls: { pdf: string; source: string },
  titleHint: string,
) {
  const form = new FormData();
  form.set("pdf", new File([new Uint8Array(bytes)], filename, { type: "application/pdf" }));
  form.set("pdf_url", urls.pdf);
  form.set("source_url", urls.source);
  form.set("title_hint", titleHint);
  const response = await app.request(`${origin}/capture-bytes`, { method: "POST", body: form });
  expect(response.status).toBe(200);
}

async function item(app: ReturnType<typeof createApp>, key: string) {
  const payload = LibraryPayloadSchema.parse(
    await (await app.request(`${origin}/api/library`)).json(),
  );
  const found = payload.items.find((candidate) => candidate.id === key);
  if (found === undefined) {
    throw new Error(`the library lists no item ${key}`);
  }
  return found;
}

async function citationTitle(app: ReturnType<typeof createApp>, key: string) {
  const { document } = parseHTML(await (await app.request(`${origin}/read/${key}`)).text());
  return document.querySelector('meta[name="citation_title"]')?.getAttribute("content");
}

async function citationAuthors(app: ReturnType<typeof createApp>, key: string) {
  const { document } = parseHTML(await (await app.request(`${origin}/read/${key}`)).text());
  return [...document.querySelectorAll('meta[name="citation_author"]')].map((meta) =>
    meta.getAttribute("content"),
  );
}

const ARXIV_AUTHORS = [
  "Maria Fernanda Zordan Bonini",
  "Robson Ricardo de Araujo",
  "Antonio Aparecido de Andrade",
  "Jéfferson Luiz Rocha Bastos",
];

const arxiv = {
  pdf: "https://arxiv.org/pdf/2609.21174v1",
  source: "https://arxiv.org/abs/2609.21174v1",
};

test("an arXiv capture takes its title from the arXiv resolver, not from the link text", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  await capture(bucket(root, replayManifest), arxivPdf, "2609.21174v1", arxiv, "View PDF");

  // A fresh server over the same root: the title is read back from the stored PDF.
  const reread = bucket(root, replayManifest);
  const captured = await item(reread, "2609.21174v1");
  expect(captured.title).toBe("On The Cyclicity of Algebraic Lattices");
  expect(captured.titleSource).toBe("resolver");
  expect(captured.provenance.title_hint).toBe("View PDF");
  expect(await citationTitle(reread, "2609.21174v1")).toBe(
    "On The Cyclicity of Algebraic Lattices",
  );
  expect(captured.authors).toEqual(ARXIV_AUTHORS);
  expect(await citationAuthors(reread, "2609.21174v1")).toEqual(ARXIV_AUTHORS);
  // The year from arXiv's BibTeX; the abstract from arXiv's API, which the BibTeX lacks.
  expect(captured.year).toBe(2026);
  expect(captured.abstract).toStartWith(
    "This work presents theoretical advances in the study of cyclic and quasi-cyclic lattices.",
  );
});

test("a DOI capture takes the title from the resolved BibTeX, with its LaTeX turned into text", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  const app = bucket(root, replayManifest);
  // The lecture notes carry no title of their own: this title exists only in the DOI BibTeX,
  // which writes it as `The sphere packing problem in dimension $8$`.
  await capture(
    app,
    lectureNotes,
    "viazovska.pdf",
    {
      pdf: "https://annals.math.princeton.edu/wp-content/uploads/Viazovska.pdf",
      source: "https://doi.org/10.4007/annals.2017.185.3.7",
    },
    "Download PDF",
  );

  const captured = await item(app, "viazovska");
  expect([captured.title, captured.titleSource]).toEqual([
    "The sphere packing problem in dimension 8",
    "resolver",
  ]);
  // The lecture notes name no author: this one comes from the DOI BibTeX alone.
  expect(captured.authors).toEqual(["Maryna Viazovska"]);
  // The DOI BibTeX gives a year and no abstract.
  expect([captured.year, captured.abstract]).toEqual([2017, null]);
});

test("with the resolver unreachable, a capture succeeds and falls back to the PDF's own title, then to the hint", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  const app = bucket(root, deadManifest);
  await capture(app, arxivPdf, "2609.21174v1", arxiv, "View PDF");
  await capture(
    app,
    lectureNotes,
    "notes.pdf",
    {
      pdf: "https://www.math.example.edu/~author/notes.pdf",
      source: "https://www.math.example.edu/~author/",
    },
    "Lecture notes on lattices",
  );

  const withMetadata = await item(app, "2609.21174v1");
  const withHint = await item(app, "notes");
  expect([withMetadata.title, withMetadata.titleSource]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "pdf-metadata",
  ]);
  expect([withHint.title, withHint.titleSource]).toEqual([
    "Lecture notes on lattices",
    "capture-hint",
  ]);
  // The arXiv PDF names its authors in its own metadata; the lecture notes name none.
  expect(withMetadata.authors).toEqual(ARXIV_AUTHORS);
  expect(withHint.authors).toEqual([]);
});

test("Retrieve metadata resolves an item captured while the resolver was down", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  await capture(bucket(root, deadManifest), arxivPdf, "2609.21174v1", arxiv, "View PDF");
  const online = bucket(root, replayManifest);
  expect((await item(online, "2609.21174v1")).titleSource).toBe("pdf-metadata");

  const response = await online.request(`${origin}/api/items/2609.21174v1/metadata`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  const retrieved = RetrieveMetadataResponseSchema.parse(await response.json());
  expect(retrieved.outcome).toEqual({
    status: "resolved",
    pluginId: "arxiv",
    identifier: arxiv.source,
    title: "On The Cyclicity of Algebraic Lattices",
  });
  expect([retrieved.item.title, retrieved.item.titleSource]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "resolver",
  ]);
  expect(await item(online, "2609.21174v1")).toEqual(retrieved.item);
});

test("Retrieve metadata reports a failed resolver and keeps the title the item had", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  await capture(bucket(root, replayManifest), arxivPdf, "2609.21174v1", arxiv, "View PDF");
  const offline = bucket(root, deadManifest);

  const response = await offline.request(`${origin}/api/items/2609.21174v1/metadata`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  const retrieved = RetrieveMetadataResponseSchema.parse(await response.json());
  expect(retrieved.outcome.status).toBe("failed");
  expect([retrieved.item.title, retrieved.item.titleSource]).toEqual([
    "On The Cyclicity of Algebraic Lattices",
    "resolver",
  ]);
});

test("Retrieve metadata on an item with no identifier reports it unidentified; an unknown key is not found", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-titles-"));
  const app = bucket(root, replayManifest);
  await capture(
    app,
    lectureNotes,
    "notes.pdf",
    {
      pdf: "https://www.math.example.edu/~author/notes.pdf",
      source: "https://www.math.example.edu/~author/",
    },
    "Lecture notes on lattices",
  );

  const unidentified = RetrieveMetadataResponseSchema.parse(
    await (await app.request(`${origin}/api/items/notes/metadata`, { method: "POST" })).json(),
  );
  expect(unidentified.outcome.status).toBe("unidentified");
  expect([unidentified.item.title, unidentified.item.titleSource]).toEqual([
    "Lecture notes on lattices",
    "capture-hint",
  ]);
  expect(
    (await app.request(`${origin}/api/items/missing/metadata`, { method: "POST" })).status,
  ).toBe(404);
});
