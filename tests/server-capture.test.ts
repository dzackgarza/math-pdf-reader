import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { CaptureResponseSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { ApiErrorSchema, LibraryPayloadSchema } from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

const config = loadAppConfig(CONFIG_PATH);
const fixture = join(import.meta.dir, "fixtures/lecture-notes.pdf");
const sourcePage = "https://www.math.example.edu/~author/teaching.html";
const pdfSource = "https://www.math.example.edu/~author/lattices.pdf";

async function bucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-capture-"));
  const app = await serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  return { root, app };
}

function captureForm(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  titleHint: string,
): FormData {
  const form = new FormData();
  form.set("pdf", new File([bytes], filename, { type: "application/pdf" }));
  form.set("pdf_url", pdfSource);
  form.set("source_url", sourcePage);
  form.set("title_hint", titleHint);
  return form;
}

// The Highwire `citation_*` tags the Zotero Connector reads.
async function citationTags(response: Response): Promise<Record<string, string>> {
  const { document } = parseHTML(await response.text());
  return Object.fromEntries(
    Array.from(document.querySelectorAll("meta[name^=citation_]"), (meta) => [
      meta.getAttribute("name"),
      meta.getAttribute("content"),
    ]),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("a captured PDF is served at its PDF URL and read back into a reader page with citation tags", async () => {
  const { root, app } = await bucket();
  const original = readFileSync(fixture);
  const title = `Lattices & "Quadratic" <Forms>`;

  const captured = await app.request(`/capture-bytes`, {
    method: "POST",
    body: captureForm(original, "lattices.pdf", title),
  });
  expect(captured.status).toBe(200);
  const result = CaptureResponseSchema.parse(await captured.json());
  expect(result.key).toBe("lattices");
  expect(result.existing).toBe(false);
  expect(result.reader_url).toBe(`${app.origin}/read/lattices`);
  expect(result.provenance.original_sha256).toBe(sha256(original));
  expect(readdirSync(root)).toEqual(["lattices.pdf"]);

  const pdf = await app.request(`/pdf/lattices.pdf`);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  const served = new Uint8Array(await pdf.arrayBuffer());
  expect(sha256(served)).toBe(result.stored_sha256);
  expect(sha256(served)).toBe(sha256(readFileSync(join(root, "lattices.pdf"))));
  expect(sha256(served)).not.toBe(sha256(original));

  const reader = await app.request(result.reader_url);
  expect(reader.status).toBe(200);
  expect(await citationTags(reader)).toEqual({
    citation_title: title,
    citation_pdf_url: `${app.origin}/pdf/lattices.pdf`,
    citation_abstract_html_url: sourcePage,
  });
});

test("an upload that is not a PDF is refused and nothing is stored", async () => {
  const { root, app } = await bucket();
  const html = new TextEncoder().encode("<!doctype html><title>Access denied</title>");

  const response = await app.request(`/capture-bytes`, {
    method: "POST",
    body: captureForm(html, "paywall.pdf", "Paywall"),
  });

  expect(response.status).toBe(400);
  expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe("not_a_pdf");
  expect(readdirSync(root)).toEqual([]);
});

test("keys that name no stored PDF are not found, including encoded traversal", async () => {
  const { app } = await bucket();
  const outside = await app.request(`/capture-bytes`, {
    method: "POST",
    body: captureForm(readFileSync(fixture), "outside.pdf", "Outside"),
  });
  expect(outside.status).toBe(200);

  expect((await app.request(`/read/missing`)).status).toBe(404);
  expect((await app.request(`/pdf/missing.pdf`)).status).toBe(404);
  expect((await app.request(`/pdf/..%2F..%2Fetc%2Fpasswd.pdf`)).status).toBe(404);
  expect((await app.request(`/read/..%2Foutside`)).status).toBe(404);
});

test("PDFs captured at once under one file name all land, each under its own key", async () => {
  const { root, app } = await bucket();
  const pdfs = ["lecture-notes.pdf", "problem-set.pdf", "ten-page-notes.pdf"].map((name) =>
    readFileSync(join(import.meta.dir, "fixtures", name)),
  );

  const responses = await Promise.all(
    pdfs.map((bytes) =>
      app.request(`/capture-bytes`, {
        method: "POST",
        body: captureForm(bytes, "download.pdf", "Download"),
      }),
    ),
  );

  const results = await Promise.all(
    responses.map(async (response) => CaptureResponseSchema.parse(await response.json())),
  );
  const keys = results.map((result) => result.key);
  expect(new Set(keys).size).toBe(3);
  expect(keys).toContain("download");
  // The files hold the PDFs that were offered, one each.
  expect(results.map((result) => result.provenance.original_sha256)).toEqual(
    pdfs.map((bytes) => sha256(bytes)),
  );
  for (const result of results) {
    expect(sha256(readFileSync(join(root, `${result.key}.pdf`)))).toBe(result.stored_sha256);
  }
  expect(readdirSync(root).sort()).toEqual(keys.map((key) => `${key}.pdf`).sort());
});

test("the same PDF captured from another URL under another name is the item already stored", async () => {
  const { root, app } = await bucket();
  const bytes = readFileSync(fixture);
  const first = CaptureResponseSchema.parse(
    await (
      await app.request(`/capture-bytes`, {
        method: "POST",
        body: captureForm(bytes, "lattices.pdf", "Lattices"),
      })
    ).json(),
  );

  const form = captureForm(bytes, "fulltext.pdf", "Full text");
  form.set("pdf_url", "https://mirror.example.org/fulltext.pdf");
  const again = CaptureResponseSchema.parse(
    await (await app.request(`/capture-bytes`, { method: "POST", body: form })).json(),
  );

  expect([again.existing, again.key, again.provenance]).toEqual([
    true,
    first.key,
    first.provenance,
  ]);
  expect(readdirSync(root)).toEqual(["lattices.pdf"]);
});

test("a file name with no usable stem keys the PDF by its hash, and the library still lists it", async () => {
  const { app } = await bucket();
  const bytes = readFileSync(fixture);

  const response = await app.request(`/capture-bytes`, {
    method: "POST",
    body: captureForm(bytes, "..pdf", "Dots"),
  });

  const result = CaptureResponseSchema.parse(await response.json());
  expect(result.key).toBe(sha256(bytes).slice(0, 12));
  const library = LibraryPayloadSchema.parse(await (await app.request("/api/library")).json());
  expect(library.items.map((item) => item.id)).toEqual([result.key]);
});

test("a foreign or torn PDF in the root is named in the library beside the items it can read", async () => {
  const { root, app } = await bucket();
  await app.request(`/capture-bytes`, {
    method: "POST",
    body: captureForm(readFileSync(fixture), "lattices.pdf", "Lattices"),
  });
  copyFileSync(join(import.meta.dir, "fixtures/problem-set.pdf"), join(root, "foreign.pdf"));
  writeFileSync(join(root, "torn.pdf"), readFileSync(join(root, "lattices.pdf")).subarray(0, 300));

  const response = await app.request("/api/library");

  expect(response.status).toBe(200);
  const library = LibraryPayloadSchema.parse(await response.json());
  expect(library.items.map((item) => item.id)).toEqual(["lattices"]);
  expect(library.unreadable.map((file) => file.file)).toEqual(["foreign.pdf", "torn.pdf"]);
});
