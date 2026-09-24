import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { type CaptureResponse, CaptureResponseSchema } from "../src/server/contract";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import { RESOLVERS_MANIFEST } from "../src/server/send";
import {
  ApiErrorSchema,
  type BucketItem,
  CollectionSchema,
  ItemNoteSchema,
  LibraryPayloadSchema,
  SavedSearchSchema,
  SettingsSchema,
} from "../src/server/libraryContract";

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;
const lectureNotes = join(import.meta.dir, "fixtures/lecture-notes.pdf");
const problemSet = join(import.meta.dir, "fixtures/problem-set.pdf");

type Bucket = { root: string; request: (path: string, init?: RequestInit) => Promise<Response> };

function open(root: string): Bucket {
  const app = createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  return { root, request: async (path, init) => app.request(`${origin}${path}`, init) };
}

function emptyBucket(): Bucket {
  return open(mkdtempSync(join(tmpdir(), "pdf-bucket-library-")));
}

async function capture(
  bucket: Bucket,
  fixture: string,
  filename: string,
  title: string,
): Promise<CaptureResponse> {
  const form = new FormData();
  form.set("pdf", new File([readFileSync(fixture)], filename, { type: "application/pdf" }));
  form.set("pdf_url", `https://www.math.example.edu/~author/${filename}`);
  form.set("source_url", `https://www.math.example.edu/~author/${filename}.html`);
  form.set("title_hint", title);
  const response = await bucket.request("/capture-bytes", { method: "POST", body: form });
  return CaptureResponseSchema.parse(await response.json());
}

async function library(bucket: Bucket) {
  const response = await bucket.request("/api/library");
  expect(response.status).toBe(200);
  return LibraryPayloadSchema.parse(await response.json());
}

async function send(bucket: Bucket, method: string, path: string, body: object) {
  return bucket.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorKind(response: Response): Promise<string> {
  return ApiErrorSchema.parse(await response.json()).error.kind;
}

function byId(items: BucketItem[]): Map<string, BucketItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("the library lists every stored PDF with the provenance read back from the file", async () => {
  const bucket = emptyBucket();
  const lattices = await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  const problems = await capture(bucket, problemSet, "problems.pdf", "Problem Set 3");

  const items = byId((await library(bucket)).items);

  expect([...items.keys()].sort()).toEqual(["lattices", "problems"]);
  const listed = items.get("lattices");
  expect(listed?.provenance).toEqual(lattices.provenance);
  expect(listed?.title).toBe("Lattices and Codes");
  expect(listed?.url).toBe(lattices.provenance.source_url);
  expect(listed?.dateAdded).toBe(lattices.provenance.captured_at);
  expect(listed?.file).toEqual({
    path: join(bucket.root, "lattices.pdf"),
    sizeBytes: statSync(join(bucket.root, "lattices.pdf")).size,
  });
  expect(items.get("problems")?.provenance).toEqual(problems.provenance);

  const copied = emptyBucket();
  copyFileSync(join(bucket.root, "lattices.pdf"), join(copied.root, "lattices.pdf"));
  copyFileSync(join(bucket.root, "problems.pdf"), join(copied.root, "problems.pdf"));
  const fromFilesAlone = byId((await library(copied)).items);
  expect(fromFilesAlone.get("lattices")?.provenance).toEqual(lattices.provenance);
  expect(fromFilesAlone.get("problems")?.provenance).toEqual(problems.provenance);
});

test("a PDF captured after the library was first read appears on the next read", async () => {
  const bucket = emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  expect([...byId((await library(bucket)).items).keys()]).toEqual(["lattices"]);

  const later = await capture(bucket, problemSet, "-draft.pdf", "A later capture");

  expect(later.key).toBe("-draft");
  expect(byId((await library(bucket)).items).get("-draft")?.provenance).toEqual(later.provenance);
});

test("an item's extraction is derived from the Markdown and the artifact directory beside its PDF", async () => {
  const bucket = emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  const extraction = async () => byId((await library(bucket)).items).get("lattices")?.extraction;

  expect(await extraction()).toEqual({ status: "none" });

  // The runner moves artifacts first and the Markdown last; artifacts alone are no extraction.
  mkdirSync(join(bucket.root, "lattices.extraction/pages"), { recursive: true });
  writeFileSync(join(bucket.root, "lattices.extraction/content_list.json"), "[]");
  writeFileSync(join(bucket.root, "lattices.extraction/pages/page-1.png"), "png bytes");
  expect(await extraction()).toEqual({ status: "none" });

  writeFileSync(join(bucket.root, "lattices.md"), "# Lattices and Codes\n");
  expect(await extraction()).toEqual({
    status: "extracted",
    markdown: { name: "lattices.md", path: join(bucket.root, "lattices.md"), sizeBytes: 21 },
    files: [
      {
        name: "content_list.json",
        path: join(bucket.root, "lattices.extraction/content_list.json"),
        sizeBytes: 2,
      },
      {
        name: "pages/page-1.png",
        path: join(bucket.root, "lattices.extraction/pages/page-1.png"),
        sizeBytes: 9,
      },
    ],
  });
  expect(readdirSync(bucket.root).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("filing survives a server restart, and deleting the filing leaves every item intact", async () => {
  const bucket = emptyBucket();
  const lattices = await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  await capture(bucket, problemSet, "problems.pdf", "Problem Set 3");
  const pdfHashes = [
    sha256(join(bucket.root, "lattices.pdf")),
    sha256(join(bucket.root, "problems.pdf")),
  ];

  const birational = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Birational Geometry" })).json(),
  );
  const flips = CollectionSchema.parse(
    await (
      await send(bucket, "POST", "/api/collections", { name: "Flips", parentId: birational.id })
    ).json(),
  );
  await send(bucket, "PUT", "/api/items/lattices/tags", {
    tags: ["topic:Lattices", " MMP ", "MMP"],
  });
  await send(bucket, "PUT", "/api/items/lattices/collections", { collections: [flips.id] });
  await send(bucket, "POST", "/api/items/lattices/notes", { note: "Section 3 proves the bound." });
  await send(bucket, "POST", "/api/saved-searches", {
    name: "Flips papers",
    search: {
      query: "flip",
      matchCase: false,
      matchType: "all",
      searchFields: {
        title: true,
        source: false,
        pdfUrl: false,
        tags: true,
        notes: true,
        key: false,
      },
    },
  });

  const restarted = await library(open(bucket.root));
  const filed = byId(restarted.items).get("lattices");
  expect(filed?.tags).toEqual(["topic:Lattices", "MMP"]);
  expect(filed?.collections).toEqual([flips.id]);
  expect(filed?.notes.map((note) => note.note)).toEqual(["Section 3 proves the bound."]);
  expect(filed?.provenance).toEqual(lattices.provenance);
  expect(byId(restarted.items).get("problems")?.tags).toEqual([]);
  expect(restarted.collections).toEqual([birational, flips]);
  expect(restarted.savedSearches.map((search) => [search.name, search.search.query])).toEqual([
    ["Flips papers", "flip"],
  ]);

  await bucket.request(`/api/collections/${birational.id}`, { method: "DELETE" });
  const pruned = await library(open(bucket.root));
  expect(pruned.collections).toEqual([]);
  expect(byId(pruned.items).get("lattices")?.collections).toEqual([]);

  renameSync(
    join(bucket.root, "organization.json"),
    join(tmpdir(), `organization-${Date.now()}.json`),
  );
  const unfiled = byId((await library(open(bucket.root))).items);
  expect(unfiled.get("lattices")?.provenance).toEqual(lattices.provenance);
  expect(unfiled.get("lattices")?.tags).toEqual([]);
  expect(unfiled.get("lattices")?.notes).toEqual([]);
  expect([
    sha256(join(bucket.root, "lattices.pdf")),
    sha256(join(bucket.root, "problems.pdf")),
  ]).toEqual(pdfHashes);
});

test("filing refuses unknown items, unknown collections and empty tags", async () => {
  const bucket = emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");

  const missingItem = await send(bucket, "PUT", "/api/items/missing/tags", { tags: ["MMP"] });
  expect(missingItem.status).toBe(404);
  expect(await errorKind(missingItem)).toBe("unknown_item");

  const missingCollection = await send(bucket, "PUT", "/api/items/lattices/collections", {
    collections: ["no-such-collection"],
  });
  expect(missingCollection.status).toBe(400);
  expect(await errorKind(missingCollection)).toBe("unknown_collection");

  const orphan = await send(bucket, "POST", "/api/collections", {
    name: "Flips",
    parentId: "nope",
  });
  expect(orphan.status).toBe(400);
  expect(await errorKind(orphan)).toBe("unknown_collection");

  const blankTag = await send(bucket, "PUT", "/api/items/lattices/tags", { tags: ["  "] });
  expect(blankTag.status).toBe(400);
  expect(await errorKind(blankTag)).toBe("invalid_request");

  expect(byId((await library(bucket)).items).get("lattices")?.tags).toEqual([]);
});

test("the reader page shows the provenance panel and leads back to the library", async () => {
  const bucket = emptyBucket();
  const lattices = await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  await send(bucket, "PUT", "/api/items/lattices/tags", { tags: ["topic:Lattices", "MMP"] });
  const codes = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Coding Theory" })).json(),
  );
  await send(bucket, "PUT", "/api/items/lattices/collections", { collections: [codes.id] });
  await send(bucket, "POST", "/api/items/lattices/notes", {
    note: "Compare with the Leech lattice.",
  });

  const { document } = parseHTML(await (await bucket.request("/read/lattices")).text());
  const panel = z
    .object({ textContent: z.string() })
    .parse(document.querySelector("[aria-label='Provenance']"));

  expect(document.querySelector("a[href='/']")?.textContent).toContain("Library");
  for (const fact of [
    lattices.provenance.source_url,
    lattices.provenance.pdf_url,
    lattices.provenance.original_sha256,
    join(bucket.root, "lattices.pdf"),
    "Lattices",
    "MMP",
    "Coding Theory",
    "Compare with the Leech lattice.",
  ]) {
    expect(panel.textContent).toContain(fact);
  }
  expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
    "/pdfjs/web/viewer.html?file=%2Fpdf%2Flattices.pdf",
  );
});

test("renames, note deletions and saved-search deletions persist, and unknown ids are refused", async () => {
  const bucket = emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  const collection = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Lattice" })).json(),
  );
  const noted = LibraryPayloadSchema.parse(
    await (
      await send(bucket, "POST", "/api/items/lattices/notes", { note: "First reading." })
    ).json(),
  );
  const note = ItemNoteSchema.parse(byId(noted.items).get("lattices")?.notes[0]);
  const saved = SavedSearchSchema.parse(
    await (
      await send(bucket, "POST", "/api/saved-searches", {
        name: "Codes",
        search: {
          query: "codes",
          matchCase: false,
          matchType: "any",
          searchFields: {
            title: true,
            source: false,
            pdfUrl: false,
            tags: false,
            notes: false,
            key: false,
          },
        },
      })
    ).json(),
  );

  await send(bucket, "PATCH", `/api/collections/${collection.id}`, { name: "Lattices" });
  await bucket.request(`/api/items/lattices/notes/${note.id}`, { method: "DELETE" });
  await bucket.request(`/api/saved-searches/${saved.id}`, { method: "DELETE" });

  const restarted = await library(open(bucket.root));
  expect(restarted.collections).toEqual([{ id: collection.id, name: "Lattices" }]);
  expect(byId(restarted.items).get("lattices")?.notes).toEqual([]);
  expect(restarted.savedSearches).toEqual([]);

  const renameUnknown = await send(bucket, "PATCH", "/api/collections/nope", { name: "X" });
  expect(await errorKind(renameUnknown)).toBe("unknown_collection");
  const deleteUnknownNote = await bucket.request(`/api/items/lattices/notes/${note.id}`, {
    method: "DELETE",
  });
  expect(await errorKind(deleteUnknownNote)).toBe("unknown_note");
  const deleteUnknownSearch = await bucket.request(`/api/saved-searches/${saved.id}`, {
    method: "DELETE",
  });
  expect(await errorKind(deleteUnknownSearch)).toBe("unknown_saved_search");
});

test("settings report the served root, its filing file and the pinned PDF.js version", async () => {
  const bucket = emptyBucket();

  const settings = SettingsSchema.parse(await (await bucket.request("/api/settings")).json());

  expect(settings).toEqual({
    root: bucket.root,
    organizationFile: join(bucket.root, "organization.json"),
    pdfjsVersion: config.pdfjs.version,
  });
});
