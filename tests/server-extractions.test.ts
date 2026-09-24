import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtractionOutcomeSchema,
  ExtractionPluginsResponseSchema,
} from "../src/contract/extraction";
import { ApiErrorSchema } from "../src/contract/library";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

const config = loadAppConfig(CONFIG_PATH);
const fixture = join(import.meta.dir, "fixtures/ten-page-notes.pdf");
const extractor = join(import.meta.dir, "fixtures/plugins/extractor.sh");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A bucket holding the 10-page fixture under key `lattices`, served over a manifest whose
// plugins are the fixture extractor in the given modes.
async function bucketWithExtractors(plugins: { mode: string; maxPages: number }[]) {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-extract-"));
  const manifestPath = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-manifest-")),
    "extractions.json",
  );
  const manifest = {
    plugins: plugins.map(({ mode, maxPages }) => ({
      id: mode,
      name: `Fixture extractor (${mode})`,
      command: ["sh", extractor, mode, "$pdf", "$output"],
      accepted_inputs: [
        { kind: "pdf", id: "pdf", label: "PDF", limits: [{ kind: "max_pages", value: maxPages }] },
      ],
    })),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const app = await serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: manifestPath,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  const form = new FormData();
  form.set("pdf", new File([readFileSync(fixture)], "lattices.pdf", { type: "application/pdf" }));
  form.set("pdf_url", "https://www.math.example.edu/~author/lattices.pdf");
  form.set("source_url", "https://www.math.example.edu/~author/teaching.html");
  form.set("title_hint", "Ten Lectures on Integral Lattices");
  const captured = await app.request("/capture-bytes", { method: "POST", body: form });
  expect(captured.status).toBe(200);
  return { root, app };
}

test("the shipped extraction plugins are listed with their accepted inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-plugins-"));
  const app = await serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });

  const response = await app.request(`/api/plugins/extractions`);

  expect(response.status).toBe(200);
  const { plugins } = ExtractionPluginsResponseSchema.parse(await response.json());
  expect(plugins.map((plugin) => plugin.id)).toEqual([
    "mineru-flash",
    "mineru-precise",
    "mistral-ocr",
  ]);
  expect(plugins[0]?.accepted_inputs).toEqual([
    {
      kind: "pdf",
      id: "pdf",
      label: "PDF up to 20 pages and 10 MB",
      limits: [
        { kind: "max_pages", value: 20 },
        { kind: "max_bytes", value: 10000000 },
      ],
    },
  ]);
});

test("a successful run answers with the placed artifacts and their hashes", async () => {
  const { root, app } = await bucketWithExtractors([{ mode: "record", maxPages: 20 }]);

  const response = await app.request(`/api/items/lattices/extractions/record`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  const outcome = ExtractionOutcomeSchema.parse(await response.json());
  expect(readdirSync(root).sort()).toEqual(["lattices.extraction", "lattices.md", "lattices.pdf"]);
  const markdown = readFileSync(join(root, "lattices.md"));
  const pdf = readFileSync(join(root, "lattices.pdf"));
  expect(outcome).toEqual({
    status: "succeeded",
    key: "lattices",
    plugin_id: "record",
    markdown: { path: "lattices.md", sha256: sha256(markdown), size: markdown.length },
    artifacts: [{ path: "lattices.extraction/source.pdf", sha256: sha256(pdf), size: pdf.length }],
  });
});

test("a failing plugin answers 502 with its stderr and a rejected PDF answers 422, placing nothing", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "fail", maxPages: 20 },
    { mode: "markdown", maxPages: 5 },
  ]);

  const failed = await app.request(`/api/items/lattices/extractions/fail`, {
    method: "POST",
  });
  expect(failed.status).toBe(502);
  expect(ExtractionOutcomeSchema.parse(await failed.json())).toEqual({
    status: "failed",
    key: "lattices",
    plugin_id: "fail",
    exit_code: 3,
    stderr: "provider quota exhausted for this token\n",
  });

  const rejected = await app.request(`/api/items/lattices/extractions/markdown`, {
    method: "POST",
  });
  expect(rejected.status).toBe(422);
  expect(ExtractionOutcomeSchema.parse(await rejected.json())).toEqual({
    status: "rejected",
    key: "lattices",
    plugin_id: "markdown",
    violations: [{ limit: { kind: "max_pages", value: 5 }, observed: 10 }],
  });

  expect(readdirSync(root)).toEqual(["lattices.pdf"]);
});

test("unknown items and unknown plugins are not found", async () => {
  const { app } = await bucketWithExtractors([{ mode: "markdown", maxPages: 20 }]);

  const missingItem = await app.request(`/api/items/missing/extractions/markdown`, {
    method: "POST",
  });
  const missingPlugin = await app.request(`/api/items/lattices/extractions/mistral`, {
    method: "POST",
  });

  expect([missingItem.status, missingPlugin.status]).toEqual([404, 404]);
  // The library API's error shape, which the inspector reports.
  const kinds = await Promise.all(
    [missingItem, missingPlugin].map(
      async (response) => ApiErrorSchema.parse(await response.json()).error.kind,
    ),
  );
  expect(kinds).toEqual(["unknown_item", "unknown_plugin"]);
});
