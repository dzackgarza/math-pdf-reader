// The send action at the bucket's HTTP boundary, and the guard in front of every
// state-changing route. Zotero is a closed port, a replay of Zotero without the write API, or a
// loopback stand-in for the write API (tests/zotero-stub.ts) that keeps what the requests make,
// so no test here writes to a real library.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureResponseSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import {
  ApiErrorSchema,
  type BucketItem,
  LibraryPayloadSchema,
  type ZoteroRecord,
} from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";
import { unfiled, writeOrganization } from "./store";
import { type ZoteroStub, zoteroStub } from "./zotero-stub";

const lectureNotes = join(import.meta.dir, "fixtures/lecture-notes.pdf");
const problemSet = join(import.meta.dir, "fixtures/problem-set.pdf");
const extractor = join(import.meta.dir, "fixtures/plugins/extractor.sh");

const zoteroUrl = closedPortUrl();
type Bucket = {
  root: string;
  origin: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
};

async function emptyBucket(): Promise<Bucket> {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-"));
  const app = await serveBucket({
    root,
    zoteroUrl,
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  return {
    root,
    origin: app.origin,
    request: (path, init) => app.request(path, init),
  };
}

async function capture(
  bucket: Bucket,
  key: string,
  pdf: string = lectureNotes,
): Promise<void> {
  const form = new FormData();
  form.set(
    "pdf",
    new File([readFileSync(pdf)], `${key}.pdf`, {
      type: "application/pdf",
    }),
  );
  form.set("pdf_url", `https://www.math.example.edu/~author/${key}.pdf`);
  form.set("title_hint", "Lattices and Quadratic Forms");
  expect(
    CaptureResponseSchema.parse(
      await (
        await bucket.request("/capture-bytes", { method: "POST", body: form })
      ).json(),
    ),
  ).toMatchObject({ key, existing: false });
}

// A send that created ABCD2345 and attached the PDF, as the filing document records it.
const SENT: ZoteroRecord = {
  itemKey: "ABCD2345",
  sentAt: "2026-09-23T18:00:00.000Z",
  method: "page_metadata",
  steps: [{ step: "fields" }, { step: "pdf", attachmentKey: "EFGH6789" }],
};

function recordSent(bucket: Bucket, key: string): void {
  writeOrganization(bucket.root, {
    version: 2,
    collections: [],
    savedSearches: [],
    items: {
      [key]: { ...unfiled({ captured_at: SENT.sentAt }), zotero: SENT },
    },
    activity: [],
    preferences: {
      outlineOnOpen: false,
      theme: "system",
      readerNightMode: false,
    },
  });
}

async function item(
  bucket: Bucket,
  key: string,
): Promise<BucketItem | undefined> {
  const payload = LibraryPayloadSchema.parse(
    await (await bucket.request("/api/library")).json(),
  );
  return payload.items.find((candidate) => candidate.id === key);
}

async function errorKind(response: Response): Promise<string> {
  return ApiErrorSchema.parse(await response.json()).error.kind;
}

test("a send while Zotero is not running says to start Zotero and records no Zotero item", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
  });

  expect(ApiErrorSchema.parse(await response.json()).error).toMatchObject({
    kind: "zotero_unavailable",
    message: "Zotero is not running: start Zotero",
  });
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "unsent",
  });
});

test("a second send of an item already in Zotero is refused without contacting Zotero", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  recordSent(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
  });

  // A send that reached for the closed Zotero port would answer 503.
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
  writeFileSync(
    join(bucket.root, "lattices", "lattices.md"),
    "# Lattices and Quadratic Forms\n",
  );

  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: ["markdown"],
  });
  const response = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
  });

  // Not refused: the send went to attach the Markdown to ABCD2345, and Zotero was down.
  expect(await errorKind(response)).toBe("zotero_unavailable");
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

  await bucket.request("/api/items/lattices/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      note: "Lemma 2 needs the sign convention of section 1.",
    }),
  });
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: ["notes"],
  });
  const response = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
  });

  // Not refused: the send went to add the note to ABCD2345, and Zotero was down.
  expect(await errorKind(response)).toBe("zotero_unavailable");
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

test("a send to a Zotero without the write API says the addon is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-"));
  const app = await serveBucket({
    root,
    zoteroUrl: zoteroWithoutWriteApi(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  const bucket = { root, origin: app.origin, request: app.request };
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
  });

  expect(ApiErrorSchema.parse(await response.json()).error).toMatchObject({
    kind: "zotero_unavailable",
    message: "Zotero lacks the local write API addon",
  });
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "unsent",
  });
});

test("a web page on another site cannot send an item or delete it", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  const fromAnotherSite = {
    Origin: "https://pages.example.com",
    "Sec-Fetch-Site": "cross-site",
  };

  const send = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
    headers: fromAnotherSite,
  });
  const removal = await bucket.request("/api/items/lattices", {
    method: "DELETE",
    headers: fromAnotherSite,
  });

  expect(await errorKind(send)).toBe("cross_origin_request");
  expect(await errorKind(removal)).toBe("cross_origin_request");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "unsent",
  });
});

// A request to the bucket's socket under another host name, as a page on a domain that
// resolves to 127.0.0.1 (DNS rebinding) sends it: the browser counts the page and the bucket as
// one origin, so the request carries `Sec-Fetch-Site: same-origin`. fetch() writes the Host
// header from the URL, so the request goes through node:http, which sends the one given.
function requestAs(
  bucket: Bucket,
  host: string,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  const origin = new URL(bucket.origin);
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      {
        host: origin.hostname,
        port: origin.port,
        method,
        path,
        headers: { Host: host, "Sec-Fetch-Site": "same-origin" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

test("a page on another host name bound to the bucket's address can neither read nor change it", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  const port = new URL(bucket.origin).port;
  const rebound = `rebound.example:${port}`;

  const read = await requestAs(bucket, rebound, "GET", "/api/library");
  const pdf = await requestAs(bucket, rebound, "GET", "/pdf/lattices.pdf");
  const removal = await requestAs(
    bucket,
    rebound,
    "DELETE",
    "/api/items/lattices",
  );
  const own = await requestAs(
    bucket,
    `127.0.0.1:${port}`,
    "GET",
    "/api/library",
  );

  expect(ApiErrorSchema.parse(JSON.parse(read.body)).error.kind).toBe(
    "cross_origin_request",
  );
  expect(ApiErrorSchema.parse(JSON.parse(pdf.body)).error.kind).toBe(
    "cross_origin_request",
  );
  expect(ApiErrorSchema.parse(JSON.parse(removal.body)).error.kind).toBe(
    "cross_origin_request",
  );
  expect(
    LibraryPayloadSchema.parse(JSON.parse(own.body)).items.map(
      (entry) => entry.id,
    ),
  ).toContain("lattices");
});

test("a JSON route refuses a body a form on another site can send", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/notes", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ note: "planted" }),
  });

  expect(await errorKind(response)).toBe("unsupported_media_type");
  expect((await item(bucket, "lattices"))?.notes).toEqual([]);
});

test("Send PDF Only refuses an item with notes or Markdown, which a standalone PDF cannot hold", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  await bucket.request("/api/items/lattices/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      note: "Lemma 2 needs the sign convention of section 1.",
    }),
  });
  writeFileSync(
    join(bucket.root, "lattices", "lattices.md"),
    "# Lattices and Quadratic Forms\n",
  );

  const response = await bucket.request("/api/items/lattices/zotero/pdf-only", {
    method: "POST",
  });

  // Refused before the health check: a request that reached for the closed port would answer 503.
  expect(ApiErrorSchema.parse(await response.json()).error).toMatchObject({
    kind: "pdf_only_refused",
    message:
      "lattices has a note and an extraction's Markdown, which a standalone PDF in Zotero cannot hold: send it to a Zotero item",
  });
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "unsent",
  });
});

test("Send PDF Only while Zotero is not running says to start Zotero and records nothing", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero/pdf-only", {
    method: "POST",
  });

  expect(await errorKind(response)).toBe("zotero_unavailable");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "unsent",
  });
});

// A Send PDF Only that stored the PDF as the standalone attachment QRST2345.
const STANDALONE: ZoteroRecord = {
  itemKey: "QRST2345",
  sentAt: "2026-09-23T18:00:00.000Z",
  method: "standalone_attachment",
  steps: [{ step: "pdf", attachmentKey: "QRST2345" }],
};

test("a standalone PDF in Zotero owes nothing more, and every send of it is refused", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  writeOrganization(bucket.root, {
    version: 2,
    collections: [],
    savedSearches: [],
    items: {
      lattices: {
        ...unfiled({ captured_at: STANDALONE.sentAt }),
        zotero: STANDALONE,
      },
    },
    activity: [],
    preferences: {
      outlineOnOpen: false,
      theme: "system",
      readerNightMode: false,
    },
  });
  writeFileSync(
    join(bucket.root, "lattices", "lattices.md"),
    "# Lattices and Quadratic Forms\n",
  );

  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: STANDALONE,
    pending: [],
  });
  const sends = await Promise.all(
    ["/zotero", "/zotero/extracted", "/zotero/pdf-only"].map((route) =>
      bucket.request(`/api/items/lattices${route}`, { method: "POST" }),
    ),
  );

  expect(await Promise.all(sends.map(errorKind))).toEqual([
    "already_sent",
    "already_sent",
    "already_sent",
  ]);
});

// A bucket over the loopback write API, whose extraction plugins are the fixture extractor in
// the given modes, by plugin id; the send's extraction chain is those plugins in that order.
async function stubbedBucket(
  chain: Record<string, string> = { markdown: "markdown" },
): Promise<{ bucket: Bucket; zotero: ZoteroStub }> {
  const zotero = zoteroStub();
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-"));
  const manifestPath = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-manifest-")),
    "extractions.json",
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: Object.entries(chain).map(([id, mode]) => ({
        id,
        name: `Fixture extractor (${mode})`,
        source_kind: "document_structure",
        authoritative: true,
        command: ["sh", extractor, mode, "$pdf", "$output"],
        accepted_inputs: [
          { kind: "pdf", id: "pdf", label: "PDF", limits: [] },
        ],
      })),
    }),
  );
  const config = loadAppConfig(CONFIG_PATH);
  const app = await serveBucket({
    root,
    zoteroUrl: zotero.url,
    extractionsManifest: manifestPath,
    config: {
      ...config,
      plugins: { ...config.plugins, send_extraction_chain: Object.keys(chain) },
    },
  });
  return {
    bucket: { root, origin: app.origin, request: app.request },
    zotero,
  };
}

async function json(
  bucket: Bucket,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return bucket.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Files the paper in a new collection, tags it and adds a note, as the library does.
async function file(bucket: Bucket, key: string): Promise<void> {
  const collection = await (
    await json(bucket, "POST", "/api/collections", { name: "Quadratic forms" })
  ).json();
  await json(bucket, "POST", "/api/bulk/collections", {
    keys: [key],
    add: [collection.id],
    remove: [],
  });
  await json(bucket, "POST", "/api/bulk/tags", {
    keys: [key],
    add: ["topic:Lattices"],
    remove: [],
  });
  await json(bucket, "POST", `/api/items/${key}/notes`, {
    note: "Section 3 proves the bound.",
  });
}

test("capture, reading, annotation, extraction, filing, Retrieve Metadata and delete write nothing to Zotero", async () => {
  const { bucket, zotero } = await stubbedBucket();
  await capture(bucket, "lattices");
  await capture(bucket, "problems", problemSet);

  expect((await bucket.request("/read/lattices")).status).toBe(200);
  const served = await bucket.request("/pdf/lattices.pdf");
  const bytes = new Uint8Array(await served.arrayBuffer());
  const annotated = new Uint8Array([
    ...bytes,
    ...new TextEncoder().encode("\n% an incremental update\n"),
  ]);
  const saved = await bucket.request("/api/items/lattices/pdf", {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
      "If-Match": served.headers.get("ETag") ?? "",
    },
    body: annotated,
  });
  expect(saved.status).toBe(200);
  const extracted = await bucket.request(
    "/api/items/lattices/extractions/markdown",
    { method: "POST" },
  );
  expect(extracted.status).toBe(200);
  await file(bucket, "lattices");
  expect(
    (
      await json(bucket, "PUT", "/api/items/lattices/reading", {
        page: 1,
        pages: 2,
        edition: (await item(bucket, "lattices"))?.provenance,
      })
    ).status,
  ).toBe(200);
  const retrieved = await bucket.request("/api/items/lattices/metadata", {
    method: "POST",
  });
  expect(retrieved.status).toBe(200);
  const deleted = await bucket.request("/api/items/problems", {
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);

  expect((await item(bucket, "lattices"))?.extraction.status).not.toBe("none");
  // Retrieve Metadata, after each capture and when asked, only asks Zotero to resolve a URL.
  expect(zotero.writes()).toEqual([
    "resolve_url",
    "resolve_url",
    "resolve_url",
  ]);
  expect(zotero.items.size).toBe(0);
  expect(zotero.standalone).toEqual([]);
}, 30_000);
