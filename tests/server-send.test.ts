import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  SendAndExtractResponseSchema,
  SendResponseSchema,
  type ZoteroRecord,
} from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";
import { unfiled, writeOrganization } from "./store";
import { refusal, type ZoteroStub, zoteroStub } from "./zotero-stub";

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
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function localPaper(bucket: Bucket, key: string) {
  const served = await bucket.request(`/pdf/${key}.pdf`);
  const filed = await item(bucket, key);
  return {
    served: sha256(new Uint8Array(await served.arrayBuffer())),
    stored: sha256(readFileSync(join(bucket.root, key, `${key}.pdf`))),
    collections: filed?.collections,
    tags: filed?.tags,
    notes: filed?.notes.map((note) => note.note),
  };
}

async function expectPaperKept(
  bucket: Bucket,
  key: string,
  before: Awaited<ReturnType<typeof localPaper>>,
): Promise<void> {
  expect(await localPaper(bucket, key)).toEqual(before);
  expect((await bucket.request(`/read/${key}`)).status).toBe(200);
}


test("a send while Zotero is not running says to start Zotero and records no Zotero item", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  await file(bucket, "lattices");
  const before = await localPaper(bucket, "lattices");

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
  await expectPaperKept(bucket, "lattices", before);
});

test("a second send of an item already in Zotero is refused without contacting Zotero", async () => {
  const bucket = await emptyBucket();
  await capture(bucket, "lattices");
  recordSent(bucket, "lattices");
  const before = await localPaper(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero", {
    method: "POST",
  });

  expect(await errorKind(response)).toBe("already_sent");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: [],
  });
  await expectPaperKept(bucket, "lattices", before);
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

  expect(await errorKind(response)).toBe("zotero_unavailable");
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "sent",
    record: SENT,
    pending: ["notes"],
  });
});

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
  const before = await localPaper(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero/pdf-only", {
    method: "POST",
  });

  expect(ApiErrorSchema.parse(await response.json()).error).toMatchObject({
    kind: "pdf_only_refused",
    message:
      "lattices has a note and an extraction's Markdown, which a standalone PDF in Zotero cannot hold: send it to a Zotero item",
  });
  expect((await item(bucket, "lattices"))?.zotero).toEqual({
    status: "unsent",
  });
  await expectPaperKept(bucket, "lattices", before);
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
        zoom: "automatic",
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
  expect(zotero.writes()).toEqual([
    "resolve_url",
    "resolve_url",
    "resolve_url",
  ]);
  expect(zotero.items.size).toBe(0);
  expect(zotero.standalone).toEqual([]);
}, 30_000);

const LATTICES_URL = "https://www.math.example.edu/~author/lattices.pdf";

async function send(bucket: Bucket, key: string): Promise<Response> {
  return bucket.request(`/api/items/${key}/zotero`, { method: "POST" });
}

test("Send to Zotero files the new Zotero item in the collection selected in Zotero", async () => {
  const { bucket, zotero } = await stubbedBucket();
  zotero.selection = { kind: "collection", key: "LATT2345", name: "Lattices" };
  await capture(bucket, "lattices");

  const response = await send(bucket, "lattices");

  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    target: { kind: "collection", collectionKey: "LATT2345", collectionName: "Lattices" },
  });
  const sent = SendResponseSchema.parse(body);
  expect(sent.created).toBe(true);
  expect(zotero.items.get(sent.itemKey)?.collections).toEqual(["LATT2345"]);
});

test("Send to Zotero files a work Zotero already holds in the selected collection", async () => {
  const { bucket, zotero } = await stubbedBucket();
  zotero.items.set("HELD2345", {
    key: "HELD2345",
    url: LATTICES_URL,
    collections: ["OLDC2345"],
    fields: {},
    deleted: false,
  });
  zotero.selection = { kind: "collection", key: "LATT2345", name: "Lattices" };
  await capture(bucket, "lattices");

  const response = await send(bucket, "lattices");

  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    target: { kind: "collection", collectionKey: "LATT2345", collectionName: "Lattices" },
  });
  expect(SendResponseSchema.parse(body)).toMatchObject({ itemKey: "HELD2345", created: false });
  expect(zotero.items.get("HELD2345")?.collections).toEqual([
    "OLDC2345",
    "LATT2345",
  ]);
});

test("Send to Zotero with the library root selected in Zotero files the item in no collection", async () => {
  const { bucket, zotero } = await stubbedBucket();
  zotero.selection = { kind: "library_root" };
  await capture(bucket, "lattices");

  const response = await send(bucket, "lattices");

  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ target: { kind: "library" } });
  const sent = SendResponseSchema.parse(body);
  expect(zotero.items.get(sent.itemKey)?.collections).toEqual([]);
  expect(zotero.writes()).toContain("get_selected_collection");
});

async function sendPdfOnly(bucket: Bucket, key: string): Promise<Response> {
  return bucket.request(`/api/items/${key}/zotero/pdf-only`, { method: "POST" });
}

test("Send PDF Only names the collection selected in Zotero that holds the standalone PDF", async () => {
  const { bucket, zotero } = await stubbedBucket();
  zotero.selection = { kind: "collection", key: "LATT2345", name: "Lattices" };
  await capture(bucket, "lattices");

  const response = await sendPdfOnly(bucket, "lattices");

  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    target: { kind: "collection", collectionKey: "LATT2345", collectionName: "Lattices" },
  });
  expect(SendResponseSchema.parse(body).itemKey).toBe(zotero.standalone[0]?.key ?? "");
});

test("Send PDF Only with the library root selected in Zotero names the library root", async () => {
  const { bucket, zotero } = await stubbedBucket();
  zotero.selection = { kind: "library_root" };
  await capture(bucket, "lattices");

  const response = await sendPdfOnly(bucket, "lattices");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ target: { kind: "library" } });
  expect(zotero.standalone).toHaveLength(1);
});

test("Send to Zotero with no Zotero window open says so and makes no Zotero item", async () => {
  const { bucket, zotero } = await stubbedBucket();
  zotero.selection = { kind: "no_window" };
  await capture(bucket, "lattices");

  const response = await send(bucket, "lattices");

  expect(response.status).toBe(502);
  expect(ApiErrorSchema.parse(await response.json()).error).toEqual({
    kind: "zotero_failed",
    message:
      "Zotero refused get_selected_collection (409 Conflict): No Zotero window is open, so no collection is selected.",
  });
  expect(zotero.writes()).not.toContain("import_from_url");
  expect(zotero.items.size).toBe(0);
  expect((await item(bucket, "lattices"))?.zotero).toEqual({ status: "unsent" });
});

const attachesPdf = (request: { path: string; body: Record<string, unknown> | null }) =>
  request.path === "/attach" && String(request.body?.file_name).endsWith(".pdf");

test("a send whose PDF attach fails keeps the Zotero item, and the next send attaches only the PDF", async () => {
  const { bucket, zotero } = await stubbedBucket();
  await capture(bucket, "lattices");
  await file(bucket, "lattices");
  zotero.refuse = (request) =>
    attachesPdf(request)
      ? refusal(500, "attach_file_to_item", "Disk full", request.body)
      : null;
  const before = await localPaper(bucket, "lattices");

  const failed = await send(bucket, "lattices");

  expect(failed.status).toBe(502);
  expect(ApiErrorSchema.parse(await failed.json()).error).toEqual({
    kind: "zotero_failed",
    message: "Zotero refused attach_file_to_item (500 Internal Server Error): Disk full",
  });
  const [itemKey] = zotero.items.keys();
  const owed = (await item(bucket, "lattices"))?.zotero;
  expect(owed).toMatchObject({ status: "sent", record: { itemKey } });
  expect(owed?.status === "sent" && owed.pending).toContain("pdf");
  await expectPaperKept(bucket, "lattices", before);

  zotero.refuse = null;
  const retried = await send(bucket, "lattices");

  expect(retried.status).toBe(200);
  const retriedBody: unknown = await retried.json();
  expect(retriedBody).toMatchObject({ target: { kind: "earlier_send" } });
  expect(SendResponseSchema.parse(retriedBody)).toMatchObject({
    itemKey,
    created: false,
    performed: ["pdf", "notes"],
  });
  expect(zotero.writes().filter((write) => write === "import_from_url")).toHaveLength(1);
  expect(
    zotero.children(itemKey).filter((child) => child.data.contentType === "application/pdf"),
  ).toHaveLength(1);
  expect(await item(bucket, "lattices")).toBeUndefined();
}, 30_000);

test("Send to Zotero and Extract with every plugin failing sends the PDF and no Markdown", async () => {
  const { bucket, zotero } = await stubbedBucket({ quota: "fail", broken: "fail" });
  await capture(bucket, "lattices");

  const response = await bucket.request("/api/items/lattices/zotero/extracted", {
    method: "POST",
  });

  expect(response.status).toBe(200);
  const sent = SendAndExtractResponseSchema.parse(await response.json());
  expect(sent.extractions.map((outcome) => [outcome.plugin_id, outcome.status])).toEqual([
    ["quota", "failed"],
    ["broken", "failed"],
  ]);
  expect(sent.send.performed).toEqual(["fields", "pdf"]);
  const children = zotero.children(sent.send.itemKey);
  expect(children.map((child) => child.data.contentType)).toEqual(["application/pdf"]);
}, 30_000);

test("Send to Zotero and Extract attaches the PDF before any plugin runs", async () => {
  const { bucket, zotero } = await stubbedBucket({ markdown: "markdown" });
  await capture(bucket, "lattices");
  zotero.refuse = (request) =>
    attachesPdf(request)
      ? refusal(500, "attach_file_to_item", "Disk full", request.body)
      : null;

  const response = await bucket.request("/api/items/lattices/zotero/extracted", {
    method: "POST",
  });

  expect(await errorKind(response)).toBe("zotero_failed");
  expect((await item(bucket, "lattices"))?.extraction).toEqual({ status: "none" });
  expect(zotero.writes().filter((write) => write === "attach")).toHaveLength(1);
}, 30_000);

test("Send to Zotero and Extract on a paper with Markdown attaches that Markdown and runs no plugin", async () => {
  const { bucket, zotero } = await stubbedBucket({ markdown: "record" });
  await capture(bucket, "lattices");
  const markdown = "# Lattices and Quadratic Forms\n\nThe user's own extraction.\n";
  writeFileSync(join(bucket.root, "lattices", "lattices.md"), markdown);

  const response = await bucket.request("/api/items/lattices/zotero/extracted", {
    method: "POST",
  });

  expect(response.status).toBe(200);
  const sent = SendAndExtractResponseSchema.parse(await response.json());
  expect(sent.extractions).toEqual([]);
  expect(sent.send.performed).toContain("markdown");
  const attached = zotero.requests.filter(
    (request) =>
      request.path === "/attach" && request.body?.file_name === `${sent.send.itemKey}_extracted.md`,
  );
  expect(attached).toHaveLength(1);
  expect(
    Buffer.from(String(attached[0]?.body?.file_bytes_base64), "base64").toString("utf8"),
  ).toBe(markdown);
}, 30_000);

test("a send of a source Zotero cannot identify gives Zotero's reason and records no Zotero item", async () => {
  const { bucket, zotero } = await stubbedBucket();
  await capture(bucket, "lattices");
  const unidentified = readFileSync(
    join(import.meta.dir, "fixtures/zotero/resolve-unidentified.json"),
    "utf8",
  );
  zotero.refuse = (request) =>
    request.body?.operation === "import_from_url"
      ? new Response(unidentified.replaceAll("resolve_url", "import_from_url"), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        })
      : null;
  const before = await localPaper(bucket, "lattices");

  const response = await send(bucket, "lattices");

  expect(response.status).toBe(502);
  const error = ApiErrorSchema.parse(await response.json()).error;
  expect(error.kind).toBe("zotero_failed");
  expect(error.message).toStartWith(
    `Zotero refused import_from_url (422 Unprocessable Entity): ${JSON.parse(unidentified).error}`,
  );
  expect((await item(bucket, "lattices"))?.zotero).toEqual({ status: "unsent" });
  expect(zotero.items.size).toBe(0);
  await expectPaperKept(bucket, "lattices", before);
}, 30_000);

test("a send leaves a paper in the library when a Keep offline collection holds it, directly or through a subcollection, and removes any other paper", async () => {
  const { bucket } = await stubbedBucket();
  await capture(bucket, "direct", lectureNotes);
  await capture(bucket, "nested", problemSet);
  await capture(bucket, "outside", join(import.meta.dir, "fixtures/long-notes.pdf"));
  const offline = await (
    await json(bucket, "POST", "/api/collections", { name: "Offline shelf" })
  ).json();
  const shelf = await (
    await json(bucket, "POST", "/api/collections", {
      name: "Lower shelf",
      parentId: offline.id,
    })
  ).json();
  const other = await (
    await json(bucket, "POST", "/api/collections", { name: "Elsewhere" })
  ).json();
  expect(
    (await json(bucket, "PATCH", `/api/collections/${offline.id}`, { keepOffline: true }))
      .status,
  ).toBe(200);
  for (const [key, collection] of [
    ["direct", offline.id],
    ["nested", shelf.id],
    ["outside", other.id],
  ]) {
    await json(bucket, "POST", "/api/bulk/collections", {
      keys: [key],
      add: [collection],
      remove: [],
    });
  }

  const kept = [];
  for (const key of ["direct", "nested", "outside"]) {
    const response = await send(bucket, key);
    expect(response.status).toBe(200);
    kept.push([key, SendResponseSchema.parse(await response.json()).kept]);
  }

  expect(kept).toEqual([
    ["direct", true],
    ["nested", true],
    ["outside", false],
  ]);
  const payload = LibraryPayloadSchema.parse(
    await (await bucket.request("/api/library")).json(),
  );
  expect(payload.items.map((candidate) => candidate.id).sort()).toEqual([
    "direct",
    "nested",
  ]);
  expect((await bucket.request("/read/direct")).status).toBe(200);
  expect((await bucket.request("/read/nested")).status).toBe(200);
  expect((await bucket.request("/read/outside")).status).toBe(404);
}, 30_000);
