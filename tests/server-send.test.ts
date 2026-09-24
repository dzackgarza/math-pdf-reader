// The send action's own rules at the bucket's HTTP boundary. Zotero is a closed port here, so
// any request that reaches for Zotero fails loudly instead of writing to a real library; the
// Zotero write path itself is proved by the evidence run in docs/m3.md.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import {
  ApiErrorSchema,
  type BucketItem,
  LibraryPayloadSchema,
  type ZoteroRecord,
} from "../src/server/libraryContract";
import { unfiled } from "../src/server/organization";
import { RESOLVERS_MANIFEST } from "../src/server/send";

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;
const lectureNotes = join(import.meta.dir, "fixtures/lecture-notes.pdf");

// A port nothing listens on: bound once, then released.
function closedPortUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = server.url.origin;
  server.stop(true);
  return url;
}

const zoteroUrl = closedPortUrl();
type Bucket = { root: string; request: (path: string, init?: RequestInit) => Promise<Response> };

function emptyBucket(): Bucket {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-"));
  const app = createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport: null,
  });
  return { root, request: async (path, init) => app.request(`${origin}${path}`, init) };
}

async function capture(bucket: Bucket, key: string): Promise<void> {
  const form = new FormData();
  form.set(
    "pdf",
    new File([readFileSync(lectureNotes)], `${key}.pdf`, { type: "application/pdf" }),
  );
  form.set("pdf_url", `https://www.math.example.edu/~author/${key}.pdf`);
  form.set("source_url", "https://www.math.example.edu/~author/teaching.html");
  form.set("title_hint", "Lattices and Quadratic Forms");
  expect((await bucket.request("/capture-bytes", { method: "POST", body: form })).status).toBe(200);
}

// A send that created ABCD2345 and attached the PDF, as the filing document records it.
const SENT: ZoteroRecord = {
  itemKey: "ABCD2345",
  sentAt: "2026-09-23T18:00:00.000Z",
  source: { kind: "manuscript" },
  steps: [{ step: "fields" }, { step: "pdf", attachmentKey: "EFGH6789" }],
};

function recordSent(bucket: Bucket, key: string): void {
  const filing = { ...unfiled(SENT.sentAt), zotero: SENT };
  const organization = { version: 2, collections: [], savedSearches: [], items: { [key]: filing } };
  writeFileSync(join(bucket.root, "organization.json"), JSON.stringify(organization));
}

async function item(bucket: Bucket, key: string): Promise<BucketItem | undefined> {
  const payload = LibraryPayloadSchema.parse(await (await bucket.request("/api/library")).json());
  return payload.items.find((candidate) => candidate.id === key);
}

async function errorKind(response: Response): Promise<string> {
  return ApiErrorSchema.parse(await response.json()).error.kind;
}

test("a send while Zotero does not answer fails visibly and records no Zotero item", async () => {
  const bucket = emptyBucket();
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", { method: "POST" });

  expect(response.status).toBe(502);
  expect(await errorKind(response)).toBe("zotero_failed");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({ status: "unsent" });
});

test("a second send of an item already in Zotero is refused without contacting Zotero", async () => {
  const bucket = emptyBucket();
  await capture(bucket, "lattices");
  recordSent(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", { method: "POST" });

  // A request that reached the closed Zotero port would answer 502.
  expect(response.status).toBe(409);
  expect(await errorKind(response)).toBe("already_sent");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: [],
  });
});

test("an extraction made after the send is owed to Zotero, and a later send goes to attach it", async () => {
  const bucket = emptyBucket();
  await capture(bucket, "lattices");
  recordSent(bucket, "lattices");
  writeFileSync(join(bucket.root, "lattices.md"), "# Lattices and Quadratic Forms\n");

  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: ["markdown"],
  });
  const response = await bucket.request("/api/items/lattices/zotero", { method: "POST" });

  // Not refused: the send tried to attach the Markdown to ABCD2345, and Zotero was down.
  expect(response.status).toBe(502);
  expect(await errorKind(response)).toBe("zotero_failed");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: ["markdown"],
  });
});
