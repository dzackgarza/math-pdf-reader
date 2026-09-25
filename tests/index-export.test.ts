// The index export and its maintenance commands (`pdf-bucket export-index`, `import-index`,
// `rebuild-cache`) over the configured data root, $XDG_DATA_HOME/pdf-bucket, and the running
// server's rewrite of the export after every change.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import type { IndexExport } from "../src/contract/files";
import { RebuildOutcomeSchema } from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";
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

// Every capture and restore runs the Python store in its own process.
setDefaultTimeout(30_000);

function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));
}

const lectureNotes = fixture("lecture-notes.pdf");
const problemSet = fixture("problem-set.pdf");
const tenPageNotes = fixture("ten-page-notes.pdf");
const longNotes = fixture("long-notes.pdf");

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
  const result = await captureBytes(root, {
    bytes,
    filename,
    pdfUrl: url,
    sourceUrl: at("/teaching.html"),
    titleHint: `Notes from ${filename}`,
  });
  return result.item;
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
  await capture(root, lectureNotes, "revised.pdf", at("/revised/notes.pdf"));
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
    },
    {
      key: "lecture-notes",
      status: "restored",
      from: at("/notes/lecture-notes.pdf"),
      stored_sha256: sha256(readFileSync(join(root, "lecture-notes.pdf"))),
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

  const tagged = await app.request("/api/items/lecture-notes/tags", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: ["lattices", "topic:quadratic forms"] }),
  });
  expect(tagged.status).toBe(200);
  const afterTagging = await exported((index) => index.items[0]?.filing.tags.length === 2);
  expect(afterTagging.items[0]?.filing.tags).toEqual(["lattices", "topic:quadratic forms"]);

  const deleted = await app.request("/api/items/lecture-notes", { method: "DELETE" });
  expect(deleted.status).toBe(200);
  const afterDelete = await exported((index) => index.items.length === 0);
  expect(afterDelete.items).toEqual([]);
});
