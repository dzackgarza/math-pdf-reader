// Import URL and Add Folder through the real server and store: a local publisher serves a
// PDF, an abstract page naming its PDF with Highwire tags, and a page naming none.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ApiErrorSchema,
  FolderImportResponseSchema,
  ImportUrlResponseSchema,
  LibraryPayloadSchema,
} from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

setDefaultTimeout(30_000);

const fixtures = join(import.meta.dir, "fixtures");
const lectureNotes = new Uint8Array(readFileSync(join(fixtures, "lecture-notes.pdf")));
const problemSet = new Uint8Array(readFileSync(join(fixtures, "problem-set.pdf")));

const html = (body: string) =>
  new Response(`<!doctype html><html><head>${body}</head><body></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
const pdf = (bytes: Uint8Array<ArrayBuffer>) =>
  new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
// A PDF another bucket stored, passed on by a second site; set by the test that serves it.
let passedOn: Uint8Array<ArrayBuffer> | undefined;

// A download of /slow/streamed.pdf that has sent the first half of its PDF and waits for the
// test to send the rest or to drop the connection.
type Stalled = { finish(): void; cut(): void };
const stalled: Stalled[] = [];
const stalling = (bytes: Uint8Array<ArrayBuffer>) => {
  const half = Math.floor(bytes.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, half));
      stalled.push({
        finish: () => {
          controller.enqueue(bytes.slice(half));
          controller.close();
        },
        cut: () => controller.error(new Error("the publisher dropped the connection")),
      });
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/pdf" } });
};

const publisher = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/papers/lattices.pdf") {
      return pdf(lectureNotes);
    }
    if (path === "/slow/streamed.pdf") {
      return stalling(lectureNotes);
    }
    if (path === "/pdf/2401.00001") {
      return pdf(problemSet);
    }
    if (path === "/abs/2401.00001") {
      return html(
        '<title>[2401.00001] Quadratic forms</title><meta name="citation_title" content="Problem Set on Quadratic Forms"><meta name="citation_pdf_url" content="/pdf/2401.00001">',
      );
    }
    if (path === "/shared/passed-on.pdf" && passedOn !== undefined) {
      return pdf(passedOn);
    }
    if (path === "/blog.html") {
      return html("<title>A blog post</title>");
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => publisher.stop(true));
const at = (path: string) => new URL(path, publisher.url).href;

async function bucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-import-"));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  const post = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const items = async () =>
    LibraryPayloadSchema.parse(await (await app.request("/api/library")).json()).items;
  return { root, post, items, request: app.request };
}

// The files the bucket is writing in ROOT: staged bodies and outputs not yet in place.
const staging = (root: string) => readdirSync(root).filter((name) => name.endsWith(".partial"));

async function until(holds: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!holds()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting until ${what}`);
    }
    await Bun.sleep(50);
  }
}

test("Import URL stores a PDF URL and follows an abstract page's citation_pdf_url", async () => {
  const { post, items } = await bucket();

  const direct = await post("/api/import-url", { url: at("/papers/lattices.pdf") });
  expect(direct.status).toBe(200);
  expect(ImportUrlResponseSchema.parse(await direct.json())).toEqual({
    key: "lattices",
    existing: false,
  });
  const fromPage = ImportUrlResponseSchema.parse(
    await (await post("/api/import-url", { url: at("/abs/2401.00001") })).json(),
  );
  expect(fromPage).toEqual({
    key: "2401.00001",
    existing: false,
  });

  const byKey = new Map((await items()).map((item) => [item.id, item]));
  expect(byKey.get("lattices")?.provenance).toMatchObject({
    pdf_url: at("/papers/lattices.pdf"),
  });
  expect(byKey.get("2401.00001")?.provenance).toMatchObject({
    pdf_url: at("/pdf/2401.00001"),
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

test("Import URL of a PDF another bucket stored records this capture's provenance, not the other bucket's", async () => {
  const other = await bucket();
  await other.post("/api/import-url", { url: at("/abs/2401.00001") });
  const edited = await other.request("/api/items/2401.00001/metadata", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Problem Set on Quadratic Forms",
      authors: ["Ada Lovelace"],
      year: 1843,
      abstract: "Exercises on binary quadratic forms.",
    }),
  });
  expect(edited.status).toBe(200);
  passedOn = new Uint8Array(await (await other.request("/pdf/2401.00001.pdf")).arrayBuffer());

  const { post, items } = await bucket();
  const imported = ImportUrlResponseSchema.parse(
    await (await post("/api/import-url", { url: at("/shared/passed-on.pdf") })).json(),
  );

  const item = (await items()).find((stored) => stored.id === imported.key);
  expect(item?.provenance).toMatchObject({
    pdf_url: at("/shared/passed-on.pdf"),
    title_hint: "passed-on.pdf",
  });
  // The year, the abstract and the title's source are the other bucket's records. This bucket
  // has none, so the title is the one in the PDF's standard metadata.
  expect(item).toMatchObject({
    title: "Problem Set on Quadratic Forms",
    titleSource: "pdf-metadata",
    year: null,
    abstract: null,
  });
});

test("Import URL writes a download to a staged file in the bucket root as it arrives, and leaves none behind", async () => {
  const { root, post } = await bucket();
  const url = at("/slow/streamed.pdf");

  const finished = post("/api/import-url", { url });
  await until(
    () => staging(root).some((name) => statSync(join(root, name)).size > 0),
    "the first half of the download is on disk in the bucket root",
  );
  stalled.shift()?.finish();
  const stored = await finished;
  expect(stored.status).toBe(200);
  expect(ImportUrlResponseSchema.parse(await stored.json())).toMatchObject({
    key: "streamed",
    existing: false,
  });
  expect(staging(root)).toEqual([]);

  const dropped = post("/api/import-url", { url });
  await until(() => staging(root).length > 0, "the second download is staged");
  stalled.shift()?.cut();
  const failed = await dropped;
  expect(failed.status).toBe(422);
  expect(ApiErrorSchema.parse(await failed.json()).error.kind).toBe("no_pdf_at_url");
  expect(staging(root)).toEqual([]);
});

test("Add Folder stores every PDF in the folder with file URLs as provenance, once, with one outcome per file", async () => {
  const { post, items } = await bucket();
  const folder = mkdtempSync(join(tmpdir(), "pdf-bucket-import-folder-"));
  copyFileSync(join(fixtures, "lecture-notes.pdf"), join(folder, "Lectures on Lattices.pdf"));
  copyFileSync(join(fixtures, "problem-set.pdf"), join(folder, "problem-set.pdf"));
  writeFileSync(join(folder, "notes.txt"), "not a PDF");
  writeFileSync(join(folder, "paywall.pdf"), "<!doctype html><title>Access denied</title>");

  const response = await post("/api/import-folder", { path: folder });
  expect(response.status).toBe(200);
  const imported = FolderImportResponseSchema.parse(await response.json());
  expect(imported.files).toEqual([
    {
      file: "Lectures on Lattices.pdf",
      status: "stored",
      key: "Lectures on Lattices",
    },
    { file: "paywall.pdf", status: "not_a_pdf" },
    {
      file: "problem-set.pdf",
      status: "stored",
      key: "problem-set",
    },
  ]);

  const byKey = new Map((await items()).map((item) => [item.id, item]));
  expect(byKey.get("problem-set")?.provenance).toMatchObject({
    pdf_url: pathToFileURL(join(folder, "problem-set.pdf")).href,
    title_hint: "problem-set",
  });

  const again = FolderImportResponseSchema.parse(
    await (await post("/api/import-folder", { path: folder })).json(),
  );
  expect(again.files.filter((file) => file.status === "existing")).toEqual([
    { file: "Lectures on Lattices.pdf", status: "existing", key: "Lectures on Lattices" },
    { file: "problem-set.pdf", status: "existing", key: "problem-set" },
  ]);
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

  const missing = await post("/api/import-folder", { path: join(folder, "missing") });
  expect(missing.status).toBe(400);
  expect(ApiErrorSchema.parse(await missing.json()).error.kind).toBe("not_a_folder");
  const file = await post("/api/import-folder", { path: join(folder, "notes.txt") });
  expect(file.status).toBe(400);
  expect(ApiErrorSchema.parse(await file.json()).error.kind).toBe("not_a_folder");
});

test("Add Folder answers a failed check of the folder with the operating system's error, not not_a_folder", async () => {
  const { post } = await bucket();
  const parent = mkdtempSync(join(tmpdir(), "pdf-bucket-import-folder-"));
  const folder = join(parent, "looping-folder");
  symlinkSync(folder, folder);

  const response = await post("/api/import-folder", { path: folder });

  expect(response.status).toBe(500);
  // ELOOP is errno 40 on Linux: the message carries the operating system's own answer.
  expect(await response.json()).toEqual({
    error: { kind: "folder_check_failed", message: expect.stringContaining("(os error 40)") },
  });
});
