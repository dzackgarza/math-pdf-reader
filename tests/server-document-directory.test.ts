import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_COMMAND } from "../src/contract/config";
import { LibraryPayloadSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const fixture = join(import.meta.dir, "fixtures/long-notes.pdf");
const otherFixture = join(import.meta.dir, "fixtures/ten-page-notes.pdf");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function legacyPdf(root: string, key: string, source: string) {
  const input = readFileSync(source);
  const output = join(root, `${key}.pdf`);
  const command = Bun.spawn(
    [
      ...STORE_COMMAND,
      "embed-provenance",
      "--pdf-url",
      `https://www.math.example.edu/${key}.pdf`,
      "--captured-at",
      "2026-11-24T00:00:00Z",
      "--original-sha256",
      sha256(input),
      "--title-hint",
      key,
      "--",
      source,
      output,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  expect({ status, stdout, stderr }).toEqual({
    status: 0,
    stdout: "",
    stderr: "",
  });
  return readFileSync(output);
}

test("capture gives the PDF one document directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-directory-capture-"));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  const form = new FormData();
  form.set(
    "pdf",
    new File([readFileSync(fixture)], "long-notes.pdf", {
      type: "application/pdf",
    }),
  );
  form.set("pdf_url", "https://www.math.example.edu/long-notes.pdf");
  form.set("title_hint", "Long Notes");

  expect(
    (await app.request("/capture-bytes", { method: "POST", body: form }))
      .status,
  ).toBe(200);

  expect(existsSync(join(root, "long-notes", "long-notes.pdf"))).toBe(true);
  expect(existsSync(join(root, "long-notes.pdf"))).toBe(false);
});

test("startup migrates flat and partly migrated paper records without changing their bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-directory-migration-"));
  const flat = await legacyPdf(root, "flat", fixture);
  writeFileSync(join(root, "flat.md"), "# Flat enrichment\n");
  mkdirSync(join(root, "flat.extraction"));
  writeFileSync(
    join(root, "flat.extraction", "metadata.json"),
    JSON.stringify({ sourceKind: "document_structure", authoritative: true }),
  );
  writeFileSync(join(root, "flat.extraction", "notes.txt"), "discover me");

  const partial = await legacyPdf(root, "partial", otherFixture);
  mkdirSync(join(root, "partial"));
  renameSync(join(root, "partial.pdf"), join(root, "partial", "partial.pdf"));
  writeFileSync(join(root, "partial.md"), "# Remaining enrichment\n");
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });

  const response = await app.request("/api/library");
  expect(response.status).toBe(200);
  const library = LibraryPayloadSchema.parse(await response.json());
  expect(library.items.map((item) => item.id).sort()).toEqual([
    "flat",
    "partial",
  ]);
  expect(library.items.find((item) => item.id === "flat")?.file.path).toBe(
    join(root, "flat", "flat.pdf"),
  );
  expect(library.items.find((item) => item.id === "partial")?.file.path).toBe(
    join(root, "partial", "partial.pdf"),
  );
  expect(
    library.items.find((item) => item.id === "flat")?.provenance.pdf_url,
  ).toBe("https://www.math.example.edu/flat.pdf");
  expect(
    library.items.find((item) => item.id === "flat")?.extraction,
  ).toMatchObject({
    status: "extracted",
    authoritative: true,
    markdown: { path: join(root, "flat", "flat.md") },
    files: [{ path: join(root, "flat", "flat.extraction", "notes.txt") }],
  });
  expect(readFileSync(join(root, "flat", "flat.pdf"))).toEqual(flat);
  expect(readFileSync(join(root, "partial", "partial.pdf"))).toEqual(partial);
  expect(readFileSync(join(root, "partial", "partial.md"), "utf8")).toBe(
    "# Remaining enrichment\n",
  );
  for (const path of ["flat.pdf", "flat.md", "flat.extraction", "partial.md"]) {
    expect(existsSync(join(root, path))).toBe(false);
  }
});

test("a restart does not mistake document-directory names for legacy files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-directory-restart-"));
  const keys = ["archive.pdf", "notes.md", "source.extraction"];
  for (const key of keys) {
    await legacyPdf(root, key, fixture);
  }
  const first = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  expect(
    LibraryPayloadSchema.parse(
      await (await first.request("/api/library")).json(),
    ).items.map((item) => item.id),
  ).toEqual(keys);
  await first.stop();

  const restarted = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  const library = LibraryPayloadSchema.parse(
    await (await restarted.request("/api/library")).json(),
  );
  expect(library.items.map((item) => item.id)).toEqual(keys);
  expect(library.items.map((item) => item.file.path)).toEqual(
    keys.map((key) => join(root, key, `${key}.pdf`)),
  );
  await restarted.stop();
});

test("migration refuses to overwrite a current paper artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-directory-conflict-"));
  const legacy = await legacyPdf(root, "conflict", fixture);
  mkdirSync(join(root, "conflict"));
  writeFileSync(
    join(root, "conflict", "conflict.pdf"),
    "a different current file",
  );

  await expect(
    serveBucket({
      root,
      zoteroUrl: closedPortUrl(),
      extractionsManifest: EXTRACTIONS_MANIFEST,
    }),
  ).rejects.toThrow("pdf-bucket serve exited before printing its origin");
  expect(readFileSync(join(root, "conflict", "conflict.pdf"), "utf8")).toBe(
    "a different current file",
  );
  expect(readFileSync(join(root, "conflict.pdf"))).toEqual(legacy);
});
