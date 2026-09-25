// The index export and its maintenance commands (`pdf-bucket export-index`, `import-index`,
// `rebuild-cache`, `forget`) over the configured data root, $XDG_DATA_HOME/pdf-bucket, and the
// running server's rewrite of the export after every change.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IndexExportState, ServerStatusSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { type IndexExport, RemovedKeysSchema, SessionsSchema } from "../src/contract/files";
import { LibraryPayloadSchema, RebuildOutcomeSchema } from "../src/contract/library";
import { type Bucket, EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";
import {
  bucketCommand,
  captureBytes,
  listItems,
  readIndexExport,
  readOrganization,
  unfiled,
  writeOrganization,
} from "./store";

const config = loadAppConfig(CONFIG_PATH);
// A collection's own fields as a new one has them.
const PLAIN = { description: "", pinned: false, keepOffline: false };

// Every capture and restore runs a server or a pikepdf command in its own process.
setDefaultTimeout(30_000);

function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));
}

const lectureNotes = fixture("lecture-notes.pdf");
const problemSet = fixture("problem-set.pdf");
const tenPageNotes = fixture("ten-page-notes.pdf");
const longNotes = fixture("long-notes.pdf");
const outlinedNotes = fixture("outlined-notes.pdf");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The publisher side: committed fixture PDFs served over HTTP. `/revised/notes.pdf` now
// serves different bytes than were captured from it, and `/gone/` serves nothing.
const served: Record<string, Uint8Array<ArrayBuffer>> = {
  "/notes/lecture-notes.pdf": lectureNotes,
  "/pdf/2401.00001": problemSet,
  "/teaching/ten-page-notes.pdf": tenPageNotes,
  "/revised/notes.pdf": problemSet,
};
const requested: string[] = [];
const publisher = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    requested.push(path);
    const bytes = served[path];
    if (bytes === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
  },
});
afterAll(() => publisher.stop(true));

const at = (path: string) => new URL(path, publisher.url).href;

function temporaryDirectory(label: string): string {
  return mkdtempSync(join(tmpdir(), `pdf-bucket-index-${label}-`));
}

// A scratch XDG data home: the maintenance commands work on its `pdf-bucket` data root.
function dataHome() {
  const home = temporaryDirectory("data");
  const root = join(home, "pdf-bucket");
  mkdirSync(root);
  return { home, root };
}

async function capture(
  root: string,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  url: string,
) {
  const key = await captureBytes(root, {
    bytes,
    filename,
    pdfUrl: url,
    sourceUrl: at("/teaching.html"),
    titleHint: `Notes from ${filename}`,
  });
  const [item] = await listItems(root, [key]);
  if (item === undefined) {
    throw new Error(`${key} was not stored`);
  }
  return item;
}

async function exportIndex(home: string, exportFile: string) {
  const command = await bucketCommand(home, ["export-index", exportFile]);
  expect(command).toMatchObject({ exitCode: 0 });
}

async function rebuildCache(home: string, exportFile: string) {
  const command = await bucketCommand(home, ["rebuild-cache", exportFile]);
  return {
    exitCode: command.exitCode,
    outcomes: RebuildOutcomeSchema.array().parse(JSON.parse(command.stdout)),
  };
}

test("rebuilding re-downloads each missing PDF into its key and reports dead and changed URLs by key", async () => {
  const { home, root } = dataHome();
  const exportFile = join(temporaryDirectory("export"), "index.json");
  await capture(root, lectureNotes, "lecture-notes.pdf", at("/notes/lecture-notes.pdf"));
  await capture(root, problemSet, "2401.00001", at("/pdf/2401.00001"));
  await capture(root, tenPageNotes, "ten-page-notes.pdf", at("/teaching/ten-page-notes.pdf"));
  await capture(root, longNotes, "long-notes.pdf", at("/gone/long-notes.pdf"));
  await capture(root, outlinedNotes, "revised.pdf", at("/revised/notes.pdf"));
  await exportIndex(home, exportFile);
  const exported = readIndexExport(exportFile);
  if (exported === null) {
    throw new Error("export-index wrote no export");
  }
  for (const key of ["lecture-notes", "2401.00001", "long-notes", "revised"]) {
    unlinkSync(join(root, `${key}.pdf`));
  }

  const { exitCode, outcomes } = await rebuildCache(home, exportFile);

  // Two PDFs could not be restored.
  expect(exitCode).toBe(1);
  const restored = await listItems(root, ["2401.00001", "lecture-notes", "ten-page-notes"]);
  expect(outcomes).toEqual([
    {
      key: "2401.00001",
      status: "restored",
      from: at("/pdf/2401.00001"),
      stored_sha256: sha256(readFileSync(join(root, "2401.00001.pdf"))),
      metadata: { status: "from_pdf" },
    },
    {
      key: "lecture-notes",
      status: "restored",
      from: at("/notes/lecture-notes.pdf"),
      stored_sha256: sha256(readFileSync(join(root, "lecture-notes.pdf"))),
      metadata: { status: "from_pdf" },
    },
    {
      key: "long-notes",
      status: "unrestored",
      attempts: [{ url: at("/gone/long-notes.pdf"), status: "dead", detail: "HTTP 404" }],
    },
    {
      key: "revised",
      status: "unrestored",
      attempts: [
        {
          url: at("/revised/notes.pdf"),
          status: "changed",
          detail: `serves bytes hashing to ${sha256(problemSet)}`,
        },
      ],
    },
    { key: "ten-page-notes", status: "present" },
  ]);
  // The restored files carry the provenance recorded at capture, unchanged.
  expect(restored.map(({ key, provenance }) => ({ key, provenance }))).toEqual(
    exported.items
      .filter((item) => ["2401.00001", "lecture-notes", "ten-page-notes"].includes(item.key))
      .map(({ key, provenance }) => ({ key, provenance })),
  );
  expect(restored.map((item) => item.provenance.original_sha256)).toEqual([
    sha256(problemSet),
    sha256(lectureNotes),
    sha256(tenPageNotes),
  ]);
  expect(existsSync(join(root, "long-notes.pdf"))).toBe(false);
  expect(existsSync(join(root, "revised.pdf"))).toBe(false);
  // A present PDF is never downloaded again.
  expect(requested).not.toContain("/teaching/ten-page-notes.pdf");
});

test("an export imported into an empty store and rebuilt there exports byte for byte the same", async () => {
  const original = dataHome();
  const lattices = await capture(
    original.root,
    lectureNotes,
    "lattices.pdf",
    at("/notes/lecture-notes.pdf"),
  );
  const packing = await capture(original.root, problemSet, "2401.00001", at("/pdf/2401.00001"));
  // Never filed: the store has no filing entry for it, and the import must not add one.
  await capture(
    original.root,
    tenPageNotes,
    "ten-page-notes.pdf",
    at("/teaching/ten-page-notes.pdf"),
  );
  const filedAt = "2026-09-24T10:15:00.000Z";
  writeOrganization(original.root, {
    version: 2,
    collections: [
      { ...PLAIN, id: "forms", name: "Quadratic forms" },
      { ...PLAIN, id: "even", name: "Even lattices", parentId: "forms" },
    ],
    savedSearches: [
      {
        id: "search-1",
        name: "Lattice topics",
        match: "all",
        rules: [
          {
            field: "text",
            operator: "matches",
            search: {
              query: "lattices",
              matchCase: false,
              matchType: "any",
              searchFields: {
                title: true,
                source: false,
                pdfUrl: false,
                tags: true,
                notes: false,
                key: false,
              },
            },
          },
        ],
      },
    ],
    items: {
      [lattices.key]: {
        ...unfiled(lattices.provenance),
        collections: ["even"],
        tags: ["topic:lattices", "to-read"],
        modifiedAt: filedAt,
      },
      [packing.key]: {
        ...unfiled(packing.provenance),
        tags: ["topic:packing"],
        notes: [
          {
            id: "note-1",
            note: "The E8 bound is in section 5.",
            dateAdded: filedAt,
            dateModified: filedAt,
          },
        ],
        modifiedAt: filedAt,
      },
    },
    activity: [],
    preferences: { outlineOnOpen: false, theme: "system" },
  });
  const exportFile = join(temporaryDirectory("export"), "index.json");
  await exportIndex(original.home, exportFile);

  const restored = dataHome();
  const imported = await bucketCommand(restored.home, ["import-index", exportFile]);
  expect(imported.exitCode).toBe(0);
  expect(readOrganization(restored.root)).toEqual(readOrganization(original.root));
  const { exitCode, outcomes } = await rebuildCache(restored.home, exportFile);
  expect(exitCode).toBe(0);
  expect(outcomes.map((outcome) => [outcome.key, outcome.status])).toEqual([
    ["2401.00001", "restored"],
    ["lattices", "restored"],
    ["ten-page-notes", "restored"],
  ]);
  const reexportFile = join(temporaryDirectory("reexport"), "index.json");
  await exportIndex(restored.home, reexportFile);

  expect(readFileSync(reexportFile, "utf8")).toBe(readFileSync(exportFile, "utf8"));
});

test("an export never drops an item whose PDF is missing, and import never overwrites filing", async () => {
  const { home, root } = dataHome();
  const exportFile = join(temporaryDirectory("export"), "index.json");
  await capture(root, lectureNotes, "lecture-notes.pdf", at("/notes/lecture-notes.pdf"));
  const packing = await capture(root, problemSet, "2401.00001", at("/pdf/2401.00001"));
  const filing = {
    version: 2 as const,
    collections: [],
    savedSearches: [],
    items: {
      [packing.key]: {
        ...unfiled(packing.provenance),
        tags: ["topic:packing"],
        modifiedAt: "2026-09-24T10:15:00.000Z",
      },
    },
    activity: [],
    preferences: { outlineOnOpen: false, theme: "system" as const },
  };
  writeOrganization(root, filing);
  await exportIndex(home, exportFile);
  const before = readFileSync(exportFile, "utf8");
  unlinkSync(join(root, "lecture-notes.pdf"));

  const reexport = await bucketCommand(home, ["export-index", exportFile]);
  const reimport = await bucketCommand(home, ["import-index", exportFile]);

  expect(reexport.exitCode).toBe(1);
  expect(readFileSync(exportFile, "utf8")).toBe(before);
  expect(reimport.exitCode).toBe(1);
  expect(readOrganization(root)).toEqual(filing);
});

test("the running server rewrites the index export after a capture, a filing change and a delete", async () => {
  const root = temporaryDirectory("server");
  const exportFile = join(temporaryDirectory("server-export"), "index.json");
  const app = await serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport: exportFile,
  });
  // The export lands after the response; its content, not its timing, is the claim.
  const exported = async (done: (index: IndexExport) => boolean) => {
    for (;;) {
      const index = readIndexExport(exportFile);
      if (index !== null && done(index)) {
        return index;
      }
      await Bun.sleep(50);
    }
  };

  const form = new FormData();
  form.set("pdf", new File([lectureNotes], "lecture-notes.pdf", { type: "application/pdf" }));
  form.set("pdf_url", at("/notes/lecture-notes.pdf"));
  form.set("source_url", at("/teaching.html"));
  form.set("title_hint", "Lecture notes on lattices");
  const captured = await app.request("/capture-bytes", { method: "POST", body: form });
  expect(captured.status).toBe(200);
  const afterCapture = await exported((index) => index.items.length === 1);
  expect(afterCapture.items[0]?.key).toBe("lecture-notes");
  expect(afterCapture.items[0]?.provenance.original_sha256).toBe(sha256(lectureNotes));

  const tagged = await app.request("/api/bulk/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keys: ["lecture-notes"],
      add: ["lattices", "topic:quadratic forms"],
      remove: [],
    }),
  });
  expect(tagged.status).toBe(200);
  const afterTagging = await exported((index) => index.items[0]?.filing.tags.length === 2);
  expect(afterTagging.items[0]?.filing.tags).toEqual(["lattices", "topic:quadratic forms"]);

  const deleted = await app.request("/api/items/lecture-notes", { method: "DELETE" });
  expect(deleted.status).toBe(200);
  const afterDelete = await exported((index) => index.items.length === 0);
  expect(afterDelete.items).toEqual([]);
});

// A server over ROOT that rewrites EXPORT_FILE.
function serve(root: string, exportFile: string) {
  return serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport: exportFile,
  });
}

// The export at FILE once DONE holds for it; the export lands after the response.
async function exportedWhen(file: string, done: (index: IndexExport) => boolean) {
  for (;;) {
    const index = readIndexExport(file);
    if (index !== null && done(index)) {
      return index;
    }
    await Bun.sleep(50);
  }
}

async function captureOver(app: Bucket, bytes: Uint8Array<ArrayBuffer>, filename: string) {
  const form = new FormData();
  form.set("pdf", new File([bytes], filename, { type: "application/pdf" }));
  form.set("pdf_url", at(`/notes/${filename}`));
  form.set("source_url", at("/teaching.html"));
  form.set("title_hint", `Notes from ${filename}`);
  const captured = await app.request("/capture-bytes", { method: "POST", body: form });
  expect(captured.status).toBe(200);
}

async function exportState(app: Bucket, status: IndexExportState["status"]) {
  for (;;) {
    const read = ServerStatusSchema.parse(await (await app.request("/status")).json());
    if (read.index_export.status === status) {
      return read.index_export;
    }
    await Bun.sleep(50);
  }
}

test("an item deleted in the app stays removed for an export written after the app quit", async () => {
  const { home, root } = dataHome();
  const exportFile = join(temporaryDirectory("export"), "index.json");
  const first = await serve(root, exportFile);
  await captureOver(first, lectureNotes, "lattices.pdf");
  await captureOver(first, problemSet, "packing.pdf");
  await exportedWhen(exportFile, (index) => index.items.length === 2);
  await first.stop();

  // The app deletes one item and quits before it rewrites this export.
  const second = await serve(root, join(temporaryDirectory("other-export"), "index.json"));
  expect((await second.request("/api/items/lattices", { method: "DELETE" })).status).toBe(200);
  await second.stop();
  expect(readIndexExport(exportFile)?.items.map((item) => item.key)).toEqual([
    "lattices",
    "packing",
  ]);

  const exported = await bucketCommand(home, ["export-index", exportFile]);

  expect(exported.exitCode).toBe(0);
  expect(readIndexExport(exportFile)?.items.map((item) => item.key)).toEqual(["packing"]);
});

test("a refused export shows in /status until the missing item is rebuilt or forgotten", async () => {
  const { root } = dataHome();
  const exportFile = join(temporaryDirectory("export"), "index.json");
  const app = await serve(root, exportFile);
  await captureOver(app, lectureNotes, "lattices.pdf");
  await captureOver(app, problemSet, "packing.pdf");
  await exportedWhen(exportFile, (index) => index.items.length === 2);
  unlinkSync(join(root, "packing.pdf"));
  const before = readFileSync(exportFile, "utf8");

  await app.request("/api/bulk/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: ["lattices"], add: ["codes"], remove: [] }),
  });

  expect(await exportState(app, "refused")).toEqual({
    status: "refused",
    file: exportFile,
    missing: ["packing"],
  });
  expect(readFileSync(exportFile, "utf8")).toBe(before);
  const library = LibraryPayloadSchema.parse(await (await app.request("/api/library")).json());
  expect(library.missing.map((item) => item.key)).toEqual(["packing"]);

  const stored = await app.request("/api/missing/lattices", { method: "DELETE" });
  expect(stored.status).toBe(400);
  expect((await app.request("/api/missing/nothing", { method: "DELETE" })).status).toBe(404);
  const forgotten = await app.request("/api/missing/packing", { method: "DELETE" });
  expect(forgotten.status).toBe(200);
  expect(LibraryPayloadSchema.parse(await forgotten.json()).missing).toEqual([]);

  expect(await exportState(app, "written")).toMatchObject({ file: exportFile, items: 1 });
  expect(readIndexExport(exportFile)?.items.map((item) => [item.key, item.filing.tags])).toEqual([
    ["lattices", ["codes"]],
  ]);
});

test("a stored PDF whose check fails is neither forgotten nor not found: the operating system's error answers", async () => {
  const { root } = dataHome();
  const exportFile = join(temporaryDirectory("export"), "index.json");
  const app = await serve(root, exportFile);
  await captureOver(app, lectureNotes, "lattices.pdf");
  await exportedWhen(exportFile, (index) => index.items.length === 1);
  const stored = join(root, "lattices.pdf");
  unlinkSync(stored);
  symlinkSync(stored, stored);
  // ELOOP is errno 40 on Linux: the message carries the operating system's own answer.
  const failedCheck = {
    error: { kind: "store_failed", message: expect.stringContaining("(os error 40)") },
  };

  const thumbnail = await app.request("/api/items/lattices/thumbnail?width=160");
  const forgotten = await app.request("/api/missing/lattices", { method: "DELETE" });

  expect(thumbnail.status).toBe(500);
  expect(await thumbnail.json()).toEqual(failedCheck);
  expect(forgotten.status).toBe(500);
  expect(await forgotten.json()).toEqual(failedCheck);
  expect(readIndexExport(exportFile)?.items.map((item) => item.key)).toEqual(["lattices"]);
});

test("`pdf-bucket forget` drops a missing item and writes the export without it", async () => {
  const { home, root } = dataHome();
  const exportFile = join(temporaryDirectory("export"), "index.json");
  await capture(root, lectureNotes, "lattices.pdf", at("/notes/lecture-notes.pdf"));
  await capture(root, problemSet, "2401.00001", at("/pdf/2401.00001"));
  await exportIndex(home, exportFile);
  unlinkSync(join(root, "2401.00001.pdf"));
  expect((await bucketCommand(home, ["export-index", exportFile])).exitCode).toBe(1);

  const forgotten = await bucketCommand(home, ["forget", "2401.00001", exportFile]);

  expect(forgotten.exitCode).toBe(0);
  expect(readIndexExport(exportFile)?.items.map((item) => item.key)).toEqual(["lattices"]);
  expect((await bucketCommand(home, ["forget", "lattices", exportFile])).exitCode).toBe(1);
  expect((await bucketCommand(home, ["export-index", exportFile])).exitCode).toBe(0);
});

test("the export carries reading sessions and extraction records, and imports into the empty filing a new app writes", async () => {
  const original = dataHome();
  const lattices = await capture(
    original.root,
    lectureNotes,
    "lattices.pdf",
    at("/notes/lecture-notes.pdf"),
  );
  writeOrganization(original.root, {
    version: 2,
    collections: [{ ...PLAIN, id: "forms", name: "Quadratic forms" }],
    savedSearches: [],
    items: {
      [lattices.key]: { ...unfiled(lattices.provenance), collections: ["forms"], tags: ["E8"] },
    },
    activity: [],
    preferences: { outlineOnOpen: true, theme: "dark" },
  });
  const sessions = SessionsSchema.parse({
    version: 1,
    sessions: [
      {
        id: "8a6f0b1e-2c1d-4d5e-9f00-1a2b3c4d5e6f",
        key: "lattices",
        openedAt: "2026-09-25T09:00:00.000Z",
        lastSeenAt: "2026-09-25T09:05:00.000Z",
        pages: [{ page: 1, seconds: 42 }],
        item: {
          title: lattices.title.text,
          authors: [],
          year: null,
          abstract: null,
          sourceUrl: lattices.provenance.source_url,
        },
      },
    ],
  });
  writeFileSync(join(original.root, "reading-sessions.json"), JSON.stringify(sessions));
  mkdirSync(join(original.root, "lattices.extraction"));
  writeFileSync(join(original.root, "lattices.extraction/content_list.json"), "[1]");
  writeFileSync(join(original.root, "lattices.md"), "# Lattices\n");
  const exportFile = join(temporaryDirectory("export"), "index.json");
  await exportIndex(original.home, exportFile);

  const exported = readIndexExport(exportFile);
  expect(exported?.sessions).toEqual(sessions.sessions);
  expect(exported?.items[0]?.extraction).toEqual({
    status: "extracted",
    markdown: { name: "lattices.md", sizeBytes: 11 },
    files: [{ name: "lattices.extraction/content_list.json", sizeBytes: 3 }],
  });

  // The app starts at login on the wiped root and saves a preference: its filing holds nothing.
  const restored = dataHome();
  const app = await serve(restored.root, join(temporaryDirectory("app-export"), "index.json"));
  const themed = await app.request("/api/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "light" }),
  });
  expect(themed.status).toBe(200);
  await app.stop();

  const imported = await bucketCommand(restored.home, ["import-index", exportFile]);

  expect(imported.exitCode).toBe(0);
  expect(readOrganization(restored.root)).toEqual(readOrganization(original.root));
  expect(
    SessionsSchema.parse(
      JSON.parse(readFileSync(join(restored.root, "reading-sessions.json"), "utf8")),
    ),
  ).toEqual(sessions);
});

test("a new capture under a key removed earlier starts unfiled, even when the removal was cut short", async () => {
  const { root } = dataHome();
  const lattices = await capture(
    root,
    lectureNotes,
    "lattices.pdf",
    at("/notes/lecture-notes.pdf"),
  );
  // The app trashed the PDF of a key it recorded as removed, and stopped before its filing went.
  writeOrganization(root, {
    version: 2,
    collections: [],
    savedSearches: [],
    items: {
      [lattices.key]: {
        ...unfiled(lattices.provenance),
        tags: ["old"],
        notes: [
          {
            id: "note-1",
            note: "About the old PDF.",
            dateAdded: lattices.provenance.captured_at,
            dateModified: lattices.provenance.captured_at,
          },
        ],
      },
    },
    activity: [],
    preferences: { outlineOnOpen: false, theme: "system" },
  });
  writeFileSync(
    join(root, "removed.json"),
    JSON.stringify(RemovedKeysSchema.parse({ version: 1, keys: [lattices.key] })),
  );
  unlinkSync(join(root, "lattices.pdf"));
  const app = await serve(root, join(temporaryDirectory("export"), "index.json"));

  await captureOver(app, problemSet, "lattices.pdf");

  const library = LibraryPayloadSchema.parse(await (await app.request("/api/library")).json());
  const item = library.items.find((listed) => listed.id === "lattices");
  expect(item?.provenance.original_sha256).toBe(sha256(problemSet));
  expect([item?.tags, item?.notes]).toEqual([[], []]);
});
