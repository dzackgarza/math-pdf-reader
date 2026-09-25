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
import { type CaptureResponse, CaptureResponseSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import {
  ApiErrorSchema,
  type BucketItem,
  CollectionSchema,
  ItemNoteSchema,
  LibraryPayloadSchema,
  type Rule,
  type SavedSearch,
  SavedSearchSchema,
  SettingsSchema,
} from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

const config = loadAppConfig(CONFIG_PATH);
const lectureNotes = join(import.meta.dir, "fixtures/lecture-notes.pdf");
const problemSet = join(import.meta.dir, "fixtures/problem-set.pdf");

type Bucket = { root: string; request: (path: string, init?: RequestInit) => Promise<Response> };

async function open(root: string): Promise<Bucket> {
  const app = await serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  return { root, request: (path, init) => app.request(path, init) };
}

async function emptyBucket(): Promise<Bucket> {
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
  const bucket = await emptyBucket();
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

  const copied = await emptyBucket();
  copyFileSync(join(bucket.root, "lattices.pdf"), join(copied.root, "lattices.pdf"));
  copyFileSync(join(bucket.root, "problems.pdf"), join(copied.root, "problems.pdf"));
  const fromFilesAlone = byId((await library(copied)).items);
  expect(fromFilesAlone.get("lattices")?.provenance).toEqual(lattices.provenance);
  expect(fromFilesAlone.get("problems")?.provenance).toEqual(problems.provenance);
});

test("a PDF captured after the library was first read appears on the next read", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  expect([...byId((await library(bucket)).items).keys()]).toEqual(["lattices"]);

  const later = await capture(bucket, problemSet, "-draft.pdf", "A later capture");

  expect(later.key).toBe("-draft");
  expect(byId((await library(bucket)).items).get("-draft")?.provenance).toEqual(later.provenance);
});

test("an item's extraction is derived from the Markdown and the artifact directory beside its PDF", async () => {
  const bucket = await emptyBucket();
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
  const bucket = await emptyBucket();
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
  await send(bucket, "POST", "/api/bulk/tags", {
    keys: ["lattices"],
    add: ["topic:Lattices", "MMP", "MMP"],
    remove: [],
  });
  await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices"],
    add: [flips.id],
    remove: [],
  });
  await send(bucket, "POST", "/api/items/lattices/notes", { note: "Section 3 proves the bound." });
  const flipsRule: Rule = {
    field: "text",
    operator: "matches",
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
  };
  await send(bucket, "POST", "/api/saved-searches", {
    name: "Flips papers",
    match: "all",
    rules: [flipsRule],
  });

  const restarted = await library(await open(bucket.root));
  const filed = byId(restarted.items).get("lattices");
  expect(filed?.tags).toEqual(["topic:Lattices", "MMP"]);
  expect(filed?.collections).toEqual([flips.id]);
  expect(filed?.notes.map((note) => note.note)).toEqual(["Section 3 proves the bound."]);
  expect(filed?.provenance).toEqual(lattices.provenance);
  expect(byId(restarted.items).get("problems")?.tags).toEqual([]);
  expect(restarted.collections).toEqual([birational, flips]);
  expect(restarted.savedSearches.map(({ name, match, rules }) => ({ name, match, rules }))).toEqual(
    [{ name: "Flips papers", match: "all", rules: [flipsRule] }],
  );

  await bucket.request(`/api/collections/${birational.id}`, { method: "DELETE" });
  const pruned = await library(await open(bucket.root));
  expect(pruned.collections).toEqual([]);
  expect(byId(pruned.items).get("lattices")?.collections).toEqual([]);

  renameSync(
    join(bucket.root, "organization.json"),
    join(tmpdir(), `organization-${Date.now()}.json`),
  );
  const unfiled = byId((await library(await open(bucket.root))).items);
  expect(unfiled.get("lattices")?.provenance).toEqual(lattices.provenance);
  expect(unfiled.get("lattices")?.tags).toEqual([]);
  expect(unfiled.get("lattices")?.notes).toEqual([]);
  expect([
    sha256(join(bucket.root, "lattices.pdf")),
    sha256(join(bucket.root, "problems.pdf")),
  ]).toEqual(pdfHashes);
});

test("filing refuses unknown items, unknown collections, and blank or untrimmed tags", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  const tag = (add: string[]) =>
    send(bucket, "POST", "/api/bulk/tags", { keys: ["lattices"], add, remove: [] });

  const missingItem = await send(bucket, "POST", "/api/bulk/tags", {
    keys: ["missing"],
    add: ["MMP"],
    remove: [],
  });
  expect(missingItem.status).toBe(404);
  expect(await errorKind(missingItem)).toBe("unknown_item");

  const missingCollection = await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices"],
    add: ["no-such-collection"],
    remove: [],
  });
  expect(missingCollection.status).toBe(400);
  expect(await errorKind(missingCollection)).toBe("unknown_collection");

  const orphan = await send(bucket, "POST", "/api/collections", {
    name: "Flips",
    parentId: "nope",
  });
  expect(orphan.status).toBe(400);
  expect(await errorKind(orphan)).toBe("unknown_collection");

  for (const refused of [["  "], [" MMP"], ["MMP\n"]]) {
    const response = await tag(refused);
    expect(response.status).toBe(400);
    expect(await errorKind(response)).toBe("invalid_request");
  }
  expect(
    (await send(bucket, "POST", "/api/bulk/tags", { keys: [], add: ["x"], remove: [] })).status,
  ).toBe(400);

  expect(byId((await library(bucket)).items).get("lattices")?.tags).toEqual([]);
});

test("tag and collection edits are deltas, so two edits made from the same stale copy both land", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  const forms = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Quadratic forms" })).json(),
  );
  const codes = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Codes" })).json(),
  );
  await send(bucket, "POST", "/api/bulk/tags", {
    keys: ["lattices"],
    add: ["to-read", "survey"],
    remove: [],
  });
  await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices"],
    add: [forms.id],
    remove: [],
  });

  // Two windows that both saw ["to-read", "survey"] and [forms]: one reads it, the other tags it.
  const [read, tagged, moved] = await Promise.all([
    send(bucket, "POST", "/api/bulk/tags", {
      keys: ["lattices"],
      add: ["read"],
      remove: ["to-read"],
    }),
    send(bucket, "POST", "/api/bulk/tags", { keys: ["lattices"], add: ["E8"], remove: [] }),
    send(bucket, "POST", "/api/bulk/collections", {
      keys: ["lattices"],
      add: [codes.id],
      remove: [forms.id],
    }),
  ]);
  expect([read.status, tagged.status, moved.status]).toEqual([200, 200, 200]);

  const item = byId((await library(await open(bucket.root))).items).get("lattices");
  expect(new Set(item?.tags)).toEqual(new Set(["survey", "read", "E8"]));
  expect(item?.tags[0]).toBe("survey");
  expect(item?.collections).toEqual([codes.id]);

  const unknownRemoved = await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices"],
    add: [],
    remove: ["no-such-collection"],
  });
  expect(await errorKind(unknownRemoved)).toBe("unknown_collection");
});

test("preferences are changed one field at a time", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");

  const themed = await send(bucket, "PATCH", "/api/preferences", { theme: "dark" });
  expect(themed.status).toBe(200);
  const outlined = await send(bucket, "PATCH", "/api/preferences", { outlineOnOpen: true });
  expect(LibraryPayloadSchema.parse(await outlined.json()).preferences).toEqual({
    outlineOnOpen: true,
    theme: "dark",
  });
  expect((await library(await open(bucket.root))).preferences).toEqual({
    outlineOnOpen: true,
    theme: "dark",
  });
  expect((await send(bucket, "PATCH", "/api/preferences", {})).status).toBe(400);
  expect((await send(bucket, "PATCH", "/api/preferences", { theme: "sepia" })).status).toBe(400);
});

test("renames, note deletions and saved-search deletions persist, and unknown ids are refused", async () => {
  const bucket = await emptyBucket();
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
        match: "any",
        rules: [
          {
            field: "text",
            operator: "matches",
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
          },
        ],
      })
    ).json(),
  );

  await send(bucket, "PATCH", `/api/collections/${collection.id}`, { name: "Lattices" });
  await bucket.request(`/api/items/lattices/notes/${note.id}`, { method: "DELETE" });
  await bucket.request(`/api/saved-searches/${saved.id}`, { method: "DELETE" });

  const restarted = await library(await open(bucket.root));
  expect(restarted.collections).toEqual([{ ...collection, name: "Lattices" }]);
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
  const bucket = await emptyBucket();

  const settings = SettingsSchema.parse(await (await bucket.request("/api/settings")).json());

  expect(settings).toEqual({
    root: bucket.root,
    organizationFile: join(bucket.root, "organization.json"),
    pdfjsVersion: config.pdfjs.version,
  });
});

test("a PDF saved from the reader replaces the stored file only while it keeps the item's provenance", async () => {
  const bucket = await emptyBucket();
  const lattices = await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  await capture(bucket, problemSet, "problems.pdf", "Problem Set 3");
  const stored = join(bucket.root, "lattices.pdf");
  const before = readFileSync(stored);
  const put = (key: string, body: Uint8Array<ArrayBuffer>) =>
    bucket.request(`/api/items/${key}/pdf`, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body,
    });

  // An incremental update, as PDF.js writes one: the stored bytes with objects appended.
  const annotated = new Uint8Array([
    ...before,
    ...new TextEncoder().encode("\n% an incremental update\n"),
  ]);
  const saved = await put("lattices", annotated);
  expect(saved.status).toBe(200);
  expect(readFileSync(stored)).toEqual(Buffer.from(annotated));
  expect(byId((await library(bucket)).items).get("lattices")?.provenance).toEqual(
    lattices.provenance,
  );

  // Another item's PDF carries another provenance; bytes that are no PDF carry none.
  const foreign = await put(
    "lattices",
    new Uint8Array(readFileSync(join(bucket.root, "problems.pdf"))),
  );
  expect(foreign.status).toBe(409);
  expect(await errorKind(foreign)).toBe("provenance_mismatch");
  const junk = await put("lattices", new TextEncoder().encode("not a pdf"));
  expect(junk.status).toBe(400);
  expect(readFileSync(stored)).toEqual(Buffer.from(annotated));
  expect((await put("missing", annotated)).status).toBe(404);
});

test("the reader's last viewed page is recorded per item without counting as a filing change", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  const before = byId((await library(bucket)).items).get("lattices");
  expect(before?.reading).toEqual({ status: "unread" });

  const viewed = await send(bucket, "PUT", "/api/items/lattices/reading", { page: 2, pages: 2 });
  expect(viewed.status).toBe(200);
  const after = byId((await library(await open(bucket.root))).items).get("lattices");
  expect(after?.reading).toMatchObject({ status: "viewed", page: 2, pages: 2 });
  expect(after?.dateModified).toBe(before?.dateModified ?? "");

  const beyond = await send(bucket, "PUT", "/api/items/lattices/reading", { page: 3, pages: 2 });
  expect(beyond.status).toBe(400);
  const unknown = await send(bucket, "PUT", "/api/items/missing/reading", { page: 1, pages: 2 });
  expect(unknown.status).toBe(404);
});

test("an item's first page is served as a PNG of the requested width", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  const thumbnail = async (width: number) => {
    const response = await bucket.request(`/api/items/lattices/thumbnail?width=${width}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    return new Uint8Array(await response.arrayBuffer());
  };
  // PNG: the signature, then the IHDR chunk whose first field is the width (big-endian).
  const pngWidth = (png: Uint8Array) => new DataView(png.buffer).getUint32(16);

  const small = await thumbnail(160);
  expect([...small.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(pngWidth(small)).toBe(160);
  expect(pngWidth(await thumbnail(320))).toBe(320);

  expect((await bucket.request("/api/items/missing/thumbnail?width=160")).status).toBe(404);
  expect((await bucket.request("/api/items/lattices/thumbnail?width=0")).status).toBe(400);
});

test("bulk filing adds tags and collections to every chosen item, keeping what each already had", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  await capture(bucket, problemSet, "problems.pdf", "Problem Set 3");
  await send(bucket, "POST", "/api/bulk/tags", { keys: ["lattices"], add: ["codes"], remove: [] });
  const forms = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Quadratic forms" })).json(),
  );

  const tagged = await send(bucket, "POST", "/api/bulk/tags", {
    keys: ["lattices", "problems"],
    add: ["survey", "topic:lattices"],
    remove: [],
  });
  expect(tagged.status).toBe(200);
  const filed = await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices", "problems"],
    add: [forms.id],
    remove: [],
  });
  expect(filed.status).toBe(200);
  const items = byId((await library(await open(bucket.root))).items);
  expect(items.get("lattices")?.tags).toEqual(["codes", "survey", "topic:lattices"]);
  expect(items.get("problems")?.tags).toEqual(["survey", "topic:lattices"]);
  expect(items.get("lattices")?.collections).toEqual([forms.id]);
  expect(items.get("problems")?.collections).toEqual([forms.id]);

  const unknownItem = await send(bucket, "POST", "/api/bulk/tags", {
    keys: ["lattices", "missing"],
    add: ["x"],
    remove: [],
  });
  expect(unknownItem.status).toBe(404);
  const unknownCollection = await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices"],
    add: ["no-such-collection"],
    remove: [],
  });
  expect(unknownCollection.status).toBe(400);
  expect(byId((await library(bucket)).items).get("lattices")?.tags).not.toContain("x");
});

test("a collection's description, pin and Keep offline persist, and its activity records what happened to it", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, lectureNotes, "lattices.pdf", "Lattices and Codes");
  await capture(bucket, problemSet, "problems.pdf", "Problem Set 3");
  const forms = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Quadratic forms" })).json(),
  );
  expect([forms.description, forms.pinned, forms.keepOffline]).toEqual(["", false, false]);

  await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices"],
    add: [forms.id],
    remove: [],
  });
  await send(bucket, "POST", "/api/bulk/collections", {
    keys: ["lattices", "problems"],
    add: [forms.id],
    remove: [],
  });
  await send(bucket, "POST", "/api/bulk/tags", {
    keys: ["lattices", "problems"],
    add: ["MMP"],
    remove: [],
  });
  const updated = await send(bucket, "PATCH", `/api/collections/${forms.id}`, {
    description: "Hasse–Minkowski and the genus",
    pinned: true,
    keepOffline: true,
  });
  expect(updated.status).toBe(200);
  expect((await send(bucket, "PATCH", `/api/collections/${forms.id}`, {})).status).toBe(400);

  const restarted = await library(await open(bucket.root));
  expect(restarted.collections).toEqual([
    {
      ...forms,
      description: "Hasse–Minkowski and the genus",
      pinned: true,
      keepOffline: true,
    },
  ]);
  expect(restarted.activity.map(({ at: _at, ...entry }) => entry)).toEqual([
    { kind: "created", collectionId: forms.id },
    { kind: "filed", collectionId: forms.id, count: 1 },
    // lattices was in the collection already; only problems is new to it.
    { kind: "filed", collectionId: forms.id, count: 1 },
    { kind: "tagged", collectionId: forms.id, count: 2, tags: ["MMP"] },
    { kind: "keptOffline", collectionId: forms.id, on: true },
  ]);
});

test("a smart collection's rules are stored, edited and checked against the filing", async () => {
  const bucket = await emptyBucket();
  const forms = CollectionSchema.parse(
    await (await send(bucket, "POST", "/api/collections", { name: "Quadratic forms" })).json(),
  );
  const rules: Rule[] = [
    { field: "collection", operator: "is", value: forms.id },
    { field: "reading", operator: "is", value: "unread" },
    { field: "added", operator: "within days", value: 7 },
  ];
  const created = await send(bucket, "POST", "/api/saved-searches", {
    name: "New in forms",
    match: "all",
    rules,
  });
  expect(created.status).toBe(200);
  const smart = SavedSearchSchema.parse(await created.json());

  const edited = await send(bucket, "PUT", `/api/saved-searches/${smart.id}`, {
    name: "Forms, any",
    match: "any",
    rules: [...rules, { field: "author", operator: "contains", value: "Viazovska" }],
  });
  expect(edited.status).toBe(200);
  const restarted = await library(await open(bucket.root));
  expect(restarted.savedSearches).toEqual([
    {
      id: smart.id,
      name: "Forms, any",
      match: "any",
      rules: [...rules, { field: "author", operator: "contains", value: "Viazovska" }],
    },
  ] satisfies SavedSearch[]);

  const unknownCollection = await send(bucket, "POST", "/api/saved-searches", {
    name: "Nowhere",
    match: "all",
    rules: [{ field: "collection", operator: "is", value: "no-such-collection" }],
  });
  expect(await errorKind(unknownCollection)).toBe("unknown_collection");
  const noRules = await send(bucket, "POST", "/api/saved-searches", {
    name: "Empty",
    match: "all",
    rules: [],
  });
  expect(noRules.status).toBe(400);
  const unknownSearch = await send(bucket, "PUT", "/api/saved-searches/nope", {
    name: "X",
    match: "all",
    rules,
  });
  expect(unknownSearch.status).toBe(404);
});

test("deleting a collection repairs every saved search naming it or a subcollection, keeping what each selects", async () => {
  const bucket = await emptyBucket();
  const collection = async (name: string, parentId?: string) =>
    CollectionSchema.parse(
      await (await send(bucket, "POST", "/api/collections", { name, parentId })).json(),
    );
  const forms = await collection("Quadratic forms");
  const even = await collection("Even lattices", forms.id);
  const codes = await collection("Codes");
  const unread: Rule = { field: "reading", operator: "is", value: "unread" };
  const search = async (name: string, match: "all" | "any", rules: Rule[]) =>
    SavedSearchSchema.parse(
      await (await send(bucket, "POST", "/api/saved-searches", { name, match, rules })).json(),
    );
  // "is not" a deleted collection holds for every item, "is" one for none.
  const unreadOutside = await search("Unread outside forms", "all", [
    unread,
    { field: "collection", operator: "is not", value: even.id },
  ]);
  await search("Unread in forms", "all", [
    unread,
    { field: "collection", operator: "is", value: forms.id },
  ]);
  const codesOrForms = await search("Codes or forms", "any", [
    { field: "collection", operator: "is", value: codes.id },
    { field: "collection", operator: "is", value: even.id },
  ]);
  await search("Unread or outside forms", "any", [
    unread,
    { field: "collection", operator: "is not", value: forms.id },
  ]);
  await search("Only forms", "all", [{ field: "collection", operator: "is not", value: forms.id }]);

  const deleted = await bucket.request(`/api/collections/${forms.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(200);

  const restarted = await library(await open(bucket.root));
  expect(restarted.collections).toEqual([codes]);
  expect(restarted.savedSearches).toEqual([
    { ...unreadOutside, rules: [unread] },
    { ...codesOrForms, rules: [{ field: "collection", operator: "is", value: codes.id }] },
  ]);
  const again = await bucket.request(`/api/collections/${forms.id}`, { method: "DELETE" });
  expect(await errorKind(again)).toBe("unknown_collection");
});
