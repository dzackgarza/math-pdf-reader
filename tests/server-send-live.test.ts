// The send against a real running Zotero with the local write API: each paper becomes its own
// Zotero item, even when several papers were captured from one listing page or imported from
// one folder; Send PDF Only stores a PDF as a standalone attachment; and Send to Zotero and
// Extract sends, then tries the configured plugins in order and attaches the first one's Markdown.
//
// MUTATING: the send writes into the Zotero library, so the test is opt-in with ZOTERO_LIVE=1.
// Every item a send reports as created is trashed in `afterAll`, with its attachments; an item
// the library already held is never touched. Opted in but unreachable is a failure, not a skip.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import {
  FolderImportResponseSchema,
  LibraryPayloadSchema,
  SendAndExtractResponseSchema,
  SendResponseSchema,
} from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const LIVE = process.env.ZOTERO_LIVE === "1";
const ZOTERO_URL = "http://127.0.0.1:23119";
// A send asks remote translators and metadata services, and attaches a full PDF.
const REMOTE_TIMEOUT_MS = 180_000;

const createdItemKeys: string[] = [];

afterAll(async () => {
  for (const itemKey of createdItemKeys) {
    const response = await fetch(`${ZOTERO_URL}/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "trash_item", item_key: itemKey }),
    });
    if (!response.ok) {
      throw new Error(`cleanup of ${itemKey} failed: ${await response.text()}`);
    }
  }
});

async function arxivPdf(id: string): Promise<Blob> {
  const response = await fetch(`https://arxiv.org/pdf/${id}`);
  if (!response.ok) {
    throw new Error(`arXiv answered ${response.status} for ${id}`);
  }
  return response.blob();
}

type Bucket = Awaited<ReturnType<typeof serveBucket>>;

// Sends every item in the bucket; answers the Zotero item key of each send.
async function sendAll(bucket: Bucket): Promise<string[]> {
  const library = LibraryPayloadSchema.parse(await (await bucket.request("/api/library")).json());
  const keys = library.items.map((item) => item.id);
  expect(keys).toHaveLength(2);
  const itemKeys: string[] = [];
  for (const key of keys) {
    const response = await bucket.request(`/api/items/${key}/zotero`, { method: "POST" });
    expect(response.status).toBe(200);
    const sent = SendResponseSchema.parse(await response.json());
    if (sent.created) {
      createdItemKeys.push(sent.itemKey);
    }
    itemKeys.push(sent.itemKey);
  }
  return itemKeys;
}

test.skipIf(!LIVE)(
  "two papers captured from one listing page become two Zotero items",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-live-"));
    const bucket = await serveBucket({
      root,
      zoteroUrl: ZOTERO_URL,
      extractionsManifest: EXTRACTIONS_MANIFEST,
    });
    const papers = [
      {
        key: "k3-surfaces",
        pdfUrl: "https://arxiv.org/pdf/2609.21174v1",
        bytes: Bun.file(join(import.meta.dir, "fixtures/arxiv-2609.21174v1.pdf")),
      },
      {
        key: "smectic-a",
        pdfUrl: "https://arxiv.org/pdf/2609.21175v1",
        bytes: await arxivPdf("2609.21175v1"),
      },
    ];
    for (const paper of papers) {
      const form = new FormData();
      form.set("pdf", new File([paper.bytes], `${paper.key}.pdf`, { type: "application/pdf" }));
      form.set("pdf_url", paper.pdfUrl);
      // The text of a listing page's PDF link.
      form.set("title_hint", "pdf");
      const captured = await bucket.request("/capture-bytes", { method: "POST", body: form });
      expect(captured.status).toBe(200);
    }

    expect(new Set(await sendAll(bucket)).size).toBe(2);
    await bucket.stop();
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "two papers imported from one folder become two Zotero items",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-live-"));
    const bucket = await serveBucket({
      root,
      zoteroUrl: ZOTERO_URL,
      extractionsManifest: EXTRACTIONS_MANIFEST,
    });
    const folder = mkdtempSync(join(tmpdir(), "pdf-bucket-send-live-folder-"));
    writeFileSync(
      join(folder, "k3-surfaces.pdf"),
      await Bun.file(join(import.meta.dir, "fixtures/arxiv-2609.21174v1.pdf")).bytes(),
    );
    writeFileSync(join(folder, "smectic-a.pdf"), await (await arxivPdf("2609.21175v1")).bytes());
    const imported = await bucket.request("/api/import-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    expect(imported.status).toBe(200);
    FolderImportResponseSchema.parse(await imported.json());

    expect(new Set(await sendAll(bucket)).size).toBe(2);
    await bucket.stop();
  },
  REMOTE_TIMEOUT_MS,
);

// What Zotero's local API answers for the item KEY: its type, its parent, and its title.
async function zoteroItem(
  key: string,
): Promise<{ itemType: string; parentItem?: string; title: string }> {
  const response = await fetch(`${ZOTERO_URL}/api/users/0/items/${key}`);
  if (!response.ok) {
    throw new Error(`Zotero's local API answered ${response.status} for ${key}`);
  }
  const { data } = (await response.json()) as {
    data: { itemType: string; parentItem?: string; title: string };
  };
  return data;
}

// Zotero's child items of KEY: each one's type, title and, for an attachment, media type.
type ZoteroChild = { itemType: string; title: string; contentType?: string };

async function zoteroChildren(key: string): Promise<ZoteroChild[]> {
  const response = await fetch(`${ZOTERO_URL}/api/users/0/items/${key}/children`);
  if (!response.ok) {
    throw new Error(`Zotero's local API answered ${response.status} for ${key}'s children`);
  }
  const children = (await response.json()) as { data: ZoteroChild }[];
  return children.map(({ data }) => ({
    itemType: data.itemType,
    title: data.title,
    ...(data.contentType === undefined ? {} : { contentType: data.contentType }),
  }));
}

async function captureOne(bucket: Bucket, key: string, pdfUrl: string): Promise<void> {
  const form = new FormData();
  form.set(
    "pdf",
    new File(
      [readFileSync(join(import.meta.dir, "fixtures/arxiv-2609.21174v1.pdf"))],
      `${key}.pdf`,
      { type: "application/pdf" },
    ),
  );
  form.set("pdf_url", pdfUrl);
  form.set("title_hint", "K3 surfaces");
  const captured = await bucket.request("/capture-bytes", { method: "POST", body: form });
  expect(captured.status).toBe(200);
}

test.skipIf(!LIVE)(
  "Send PDF Only stores a PDF from a one-off link as a standalone attachment, and the item leaves",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-live-"));
    const bucket = await serveBucket({
      root,
      zoteroUrl: ZOTERO_URL,
      extractionsManifest: EXTRACTIONS_MANIFEST,
    });
    // A download link that names no paper and expires, as a shadow library's does.
    await captureOne(bucket, "k3-surfaces", "https://download.example.org/get.php?md5=0f3a&key=X1");

    const response = await bucket.request("/api/items/k3-surfaces/zotero/pdf-only", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const sent = SendResponseSchema.parse(await response.json());
    createdItemKeys.push(sent.itemKey);
    expect(sent).toMatchObject({ created: true, performed: ["pdf"], kept: false });
    const attachment = await zoteroItem(sent.itemKey);
    expect(attachment.itemType).toBe("attachment");
    expect(attachment.parentItem).toBeUndefined();
    const library = LibraryPayloadSchema.parse(await (await bucket.request("/api/library")).json());
    expect(library.items).toEqual([]);
    await bucket.stop();
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "Send to Zotero and Extract sends, tries the chain in order, and attaches the first success's Markdown",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-live-"));
    const extractor = join(import.meta.dir, "fixtures/plugins/extractor.sh");
    const manifestPath = join(
      mkdtempSync(join(tmpdir(), "pdf-bucket-manifest-")),
      "extractions.json",
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        plugins: ["fail", "markdown", "record"].map((mode) => ({
          id: mode,
          name: `Fixture extractor (${mode})`,
          command: ["sh", extractor, mode, "$pdf", "$output"],
          accepted_inputs: [{ kind: "pdf", id: "pdf", label: "PDF", limits: [] }],
        })),
      }),
    );
    const config = loadAppConfig(CONFIG_PATH);
    const bucket = await serveBucket({
      root,
      zoteroUrl: ZOTERO_URL,
      extractionsManifest: manifestPath,
      config: {
        ...config,
        plugins: { ...config.plugins, send_extraction_chain: ["fail", "markdown", "record"] },
      },
    });
    await captureOne(bucket, "k3-surfaces", "https://arxiv.org/pdf/2609.21174v1");

    const response = await bucket.request("/api/items/k3-surfaces/zotero/extracted", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const answer = SendAndExtractResponseSchema.parse(await response.json());
    if (answer.send.created) {
      createdItemKeys.push(answer.send.itemKey);
    }
    // The chain stops at the first success: `record` never runs.
    expect(answer.extractions.map((outcome) => [outcome.plugin_id, outcome.status])).toEqual([
      ["fail", "failed"],
      ["markdown", "succeeded"],
    ]);
    expect(answer.send.performed).toEqual(["fields", "pdf", "markdown"]);
    const markdown = `${answer.send.itemKey}_extracted.md`;
    const children = await zoteroChildren(answer.send.itemKey);
    expect(children.filter((child) => child.title === markdown).map((child) => child.itemType)).toEqual(["attachment"]);
    const library = LibraryPayloadSchema.parse(await (await bucket.request("/api/library")).json());
    expect(library.items).toEqual([]);
    await bucket.stop();
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a send of a PDF URL Zotero identifies leaves one PDF on the new item: the bucket's copy",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-live-"));
    const bucket = await serveBucket({
      root,
      zoteroUrl: ZOTERO_URL,
      extractionsManifest: EXTRACTIONS_MANIFEST,
    });
    const form = new FormData();
    form.set(
      "pdf",
      new File([await arxivPdf("2609.21173v1")], "actors.pdf", { type: "application/pdf" }),
    );
    form.set("pdf_url", "https://arxiv.org/pdf/2609.21173v1");
    form.set("title_hint", "pdf");
    const captured = await bucket.request("/capture-bytes", { method: "POST", body: form });
    expect(captured.status).toBe(200);
    const library = LibraryPayloadSchema.parse(await (await bucket.request("/api/library")).json());

    const response = await bucket.request(`/api/items/${library.items[0]?.id}/zotero`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const sent = SendResponseSchema.parse(await response.json());
    createdItemKeys.push(sent.itemKey);
    expect(sent.created).toBe(true);
    const pdfs = (await zoteroChildren(sent.itemKey)).filter(
      (child) => child.contentType === "application/pdf",
    );
    expect(pdfs).toEqual([
      { itemType: "attachment", title: "Full Text PDF", contentType: "application/pdf" },
    ]);
    await bucket.stop();
  },
  REMOTE_TIMEOUT_MS,
);
