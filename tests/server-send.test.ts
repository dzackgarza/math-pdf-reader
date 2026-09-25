// The send action's own rules at the bucket's HTTP boundary, and the guard in front of every
// state-changing route. Zotero is a closed port here (or a replay of Zotero without the write API), so
// any request that reaches for Zotero fails loudly instead of writing to a real library; the
// Zotero write path itself is proved by the evidence run in docs/m3.md.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiErrorSchema,
  type BucketItem,
  LibraryPayloadSchema,
  type ZoteroRecord,
} from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";
import { unfiled, writeOrganization } from "./store";

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

async function emptyBucket(): Promise<Bucket> {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-"));
  const app = await serveBucket({
    root,
    zoteroUrl,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  return { root, request: (path, init) => app.request(path, init) };
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
  writeOrganization(bucket.root, {
    version: 2,
    collections: [],
    savedSearches: [],
    items: { [key]: { ...unfiled({ captured_at: SENT.sentAt }), zotero: SENT } },
    activity: [],
    preferences: { outlineOnOpen: false, theme: "system" },
  });
}

async function item(bucket: Bucket, key: string): Promise<BucketItem | undefined> {
  const payload = LibraryPayloadSchema.parse(await (await bucket.request("/api/library")).json());
  return payload.items.find((candidate) => candidate.id === key);
}

async function errorKind(response: Response): Promise<string> {
  return ApiErrorSchema.parse(await response.json()).error.kind;
}

test("a send while Zotero does not answer fails visibly and records no Zotero item", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", { method: "POST" });

  expect(response.status).toBe(502);
  expect(await errorKind(response)).toBe("zotero_failed");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({ status: "unsent" });
});

test("a second send of an item already in Zotero is refused without contacting Zotero", async () => {
  const bucket = await emptyBucket();
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
  const bucket = await emptyBucket();
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

test("a note added after the send is owed to Zotero, and a later send goes to add it", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  recordSent(bucket, "lattices");

  const noted = await bucket.request("/api/items/lattices/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: "Lemma 2 needs the sign convention of section 1." }),
  });
  expect(noted.status).toBe(200);
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: ["notes"],
  });
  const response = await bucket.request("/api/items/lattices/zotero", { method: "POST" });

  // Not refused: the send tried to add the note to ABCD2345, and Zotero was down.
  expect(response.status).toBe(502);
  expect(await errorKind(response)).toBe("zotero_failed");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: ["notes"],
  });
});

// What Zotero's own HTTP server answered on 2026-09-25 to a path no endpoint serves, as it
// does for the write API's paths when the local-write-api addon is not installed.
function zoteroWithoutWriteApi(): string {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("No endpoint found\n", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      }),
  });
  return server.url.origin;
}

test("a send to a Zotero without the write API fails as a Zotero failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-"));
  const app = await serveBucket({
    root,
    zoteroUrl: zoteroWithoutWriteApi(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  const bucket = { root, request: app.request };
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", { method: "POST" });

  expect(response.status).toBe(502);
  expect(await errorKind(response)).toBe("zotero_failed");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({ status: "unsent" });
});

test("a web page on another site cannot send an item or delete it", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  const fromAnotherSite = { Origin: "https://pages.example.com", "Sec-Fetch-Site": "cross-site" };

  const send = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
    headers: fromAnotherSite,
  });
  const removal = await bucket.request("/api/items/lattices", {
    method: "DELETE",
    headers: fromAnotherSite,
  });

  expect(send.status).toBe(403);
  expect(await errorKind(send)).toBe("cross_origin_request");
  expect(removal.status).toBe(403);
  expect(await errorKind(removal)).toBe("cross_origin_request");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({ status: "unsent" });
});

test("a JSON route refuses a body a form on another site can send", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/notes", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ note: "planted" }),
  });

  expect(response.status).toBe(415);
  expect(await errorKind(response)).toBe("unsupported_media_type");
  expect((await item(bucket, "lattices"))?.notes).toEqual([]);
});
