// The send against a real running Zotero with the local write API: each paper becomes its own
// Zotero item, even when several papers were captured from one listing page.
//
// MUTATING: the send writes into the Zotero library, so the test is opt-in with ZOTERO_LIVE=1.
// Every item a send reports as created is trashed in `afterAll`, with its attachments; an item
// the library already held is never touched. Opted in but unreachable is a failure, not a skip.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryPayloadSchema, SendResponseSchema } from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

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

test.skipIf(!LIVE)(
  "two papers captured from one listing page become two Zotero items",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-live-"));
    const bucket = await serveBucket({
      root,
      zoteroUrl: ZOTERO_URL,
      extractionsManifest: EXTRACTIONS_MANIFEST,
      resolversManifest: RESOLVERS_MANIFEST,
    });
    const listing = "https://arxiv.org/list/math/new";
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
      form.set("source_url", listing);
      // The text of a listing page's PDF link.
      form.set("title_hint", "pdf");
      const captured = await bucket.request("/capture-bytes", { method: "POST", body: form });
      expect(captured.status).toBe(200);
    }
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

    expect(new Set(itemKeys).size).toBe(2);
    await bucket.stop();
  },
  REMOTE_TIMEOUT_MS,
);
