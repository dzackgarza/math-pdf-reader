import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { CaptureResponseSchema } from "../src/server/contract";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;
const fixture = join(import.meta.dir, "fixtures/lecture-notes.pdf");
const sourcePage = "https://www.math.example.edu/~author/teaching.html";
const pdfSource = "https://www.math.example.edu/~author/lattices.pdf";

function bucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-capture-"));
  return {
    root,
    app: createApp({
      root,
      version: "0.1.0",
      pdfjsDir: pdfjsDir(config),
      zoteroUrl: config.zotero.url,
      extractionsManifest: EXTRACTIONS_MANIFEST,
      indexExport: null,
    }),
  };
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

async function metaTags(response: Response): Promise<Record<string, string>> {
  const { document } = parseHTML(await response.text());
  return Object.fromEntries(
    Array.from(document.querySelectorAll("meta[name]"), (meta) => [
      meta.getAttribute("name"),
      meta.getAttribute("content"),
    ]),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("a captured PDF is served at its PDF URL and read back into a reader page with citation tags", async () => {
  const { root, app } = bucket();
  const original = readFileSync(fixture);
  const title = `Lattices & "Quadratic" <Forms>`;

  const captured = await app.request(`${origin}/capture-bytes`, {
    method: "POST",
    body: captureForm(original, "lattices.pdf", title),
  });
  expect(captured.status).toBe(200);
  const result = CaptureResponseSchema.parse(await captured.json());
  expect(result.key).toBe("lattices");
  expect(result.existing).toBe(false);
  expect(result.reader_url).toBe(`${origin}/read/lattices`);
  expect(result.provenance.original_sha256).toBe(sha256(original));
  expect(readdirSync(root)).toEqual(["lattices.pdf"]);

  const pdf = await app.request(`${origin}/pdf/lattices.pdf`);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  const served = new Uint8Array(await pdf.arrayBuffer());
  expect(sha256(served)).toBe(result.stored_sha256);
  expect(sha256(served)).toBe(sha256(readFileSync(join(root, "lattices.pdf"))));
  expect(sha256(served)).not.toBe(sha256(original));

  const reader = await app.request(result.reader_url);
  expect(reader.status).toBe(200);
  expect(await metaTags(reader)).toEqual({
    citation_title: title,
    citation_pdf_url: `${origin}/pdf/lattices.pdf`,
    citation_abstract_html_url: sourcePage,
  });
});

test("an upload that is not a PDF is refused and nothing is stored", async () => {
  const { root, app } = bucket();
  const html = new TextEncoder().encode("<!doctype html><title>Access denied</title>");

  const response = await app.request(`${origin}/capture-bytes`, {
    method: "POST",
    body: captureForm(html, "paywall.pdf", "Paywall"),
  });

  expect(response.status).toBe(400);
  expect(readdirSync(root)).toEqual([]);
});

test("keys that name no stored PDF are not found, including encoded traversal", async () => {
  const { app } = bucket();
  const outside = await app.request(`${origin}/capture-bytes`, {
    method: "POST",
    body: captureForm(readFileSync(fixture), "outside.pdf", "Outside"),
  });
  expect(outside.status).toBe(200);

  expect((await app.request(`${origin}/read/missing`)).status).toBe(404);
  expect((await app.request(`${origin}/pdf/missing.pdf`)).status).toBe(404);
  expect((await app.request(`${origin}/pdf/..%2F..%2Fetc%2Fpasswd.pdf`)).status).toBe(404);
  expect((await app.request(`${origin}/read/..%2Foutside`)).status).toBe(404);
});
