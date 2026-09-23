// The Zotero local write API: the endpoints the local-write-api addon adds to Zotero's own
// HTTP server (`POST /write` with an `operation`, `POST /attach`), plus the reads of Zotero's
// local API (`/api/users/0/...`) that a send needs. The send action is the only caller;
// nothing else in the bucket writes to Zotero.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ChildrenSchema = z.array(
  z.object({
    key: z.string().min(1),
    data: z.object({
      itemType: z.string(),
      contentType: z.string().optional(),
      linkMode: z.string().optional(),
    }),
  }),
);

// An existing PDF attachment of an item, or none, for the send's `pdf` step.
export type ExistingPdf = { kind: "found"; attachmentKey: string } | { kind: "absent" };

// A write Zotero refused, or a Zotero that did not answer.
export class ZoteroError extends Error {}

const ErrorResponseSchema = z.object({
  success: z.literal(false),
  operation: z.string(),
  error: z.string(),
});

const ImportBibtexSchema = z.object({
  success: z.literal(true),
  operation: z.literal("import_bibtex"),
  item_key: z.string().min(1),
  details: z.object({ item_count: z.literal(1) }),
});

const ImportByIdentifierSchema = z.object({
  success: z.literal(true),
  operation: z.literal("import_by_identifier"),
  item_key: z.string().min(1),
  details: z.object({ item_count: z.literal(1) }),
});

const UpdateItemFieldsSchema = z.object({
  success: z.literal(true),
  operation: z.literal("update_item_fields"),
  details: z.object({ item_key: z.string().min(1) }),
});

const AttachSchema = z.object({
  success: z.literal(true),
  attachment_key: z.string().min(1),
});

// update_item_fields merges the fields into the item's API JSON, where Zotero reads a date-time
// only in the API's ISO 8601 UTC form `YYYY-MM-DDTHH:MM:SSZ` and drops any other.
export function zoteroDateTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19)}Z`;
}

export class ZoteroWriteApi {
  constructor(private readonly baseUrl: string) {}

  private async post<T extends z.ZodType>(
    path: string,
    body: object,
    schema: T,
  ): Promise<z.infer<T>> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((error: Error) => {
      throw new ZoteroError(`Zotero did not answer at ${url.origin}: ${error.message}`);
    });
    const json: unknown = await response.json();
    if (!response.ok) {
      const refusal = ErrorResponseSchema.parse(json);
      throw new ZoteroError(`Zotero refused ${refusal.operation}: ${refusal.error}`);
    }
    return schema.parse(json);
  }

  // Creates one item in the library root from one BibTeX entry; answers its key.
  async importBibtex(bibtex: string): Promise<string> {
    const body = { operation: "import_bibtex", bibtex };
    return (await this.post("/write", body, ImportBibtexSchema)).item_key;
  }

  // Creates one item in the library root with Zotero's own translator for the identifier
  // (for `arXiv:<id>`, its arXiv translator, which makes a preprint); answers its key.
  async importByIdentifier(identifier: string): Promise<string> {
    const body = { operation: "import_by_identifier", identifier };
    return (await this.post("/write", body, ImportByIdentifierSchema)).item_key;
  }

  // A stored PDF attachment of the item whose file hashes to `sha256`. Zotero's identifier
  // import downloads the publisher's PDF itself (arXiv's, for a preprint); when those are the
  // bytes the bucket captured, the send keeps that attachment instead of adding a second copy.
  // The local API names each attachment's file with `/file/view/url`.
  async pdfWithHash(itemKey: string, sha256: string): Promise<ExistingPdf> {
    const items = new URL(`/api/users/0/items/${itemKey}/children?format=json`, this.baseUrl);
    const children = ChildrenSchema.parse(await (await fetch(items)).json());
    const stored = children.filter(
      ({ data }) =>
        data.contentType === "application/pdf" && data.linkMode?.startsWith("imported") === true,
    );
    for (const child of stored) {
      const view = new URL(`/api/users/0/items/${child.key}/file/view/url`, this.baseUrl);
      const fileUrl = (await (await fetch(view)).text()).trim();
      const bytes = await readFile(fileURLToPath(fileUrl));
      if (createHash("sha256").update(bytes).digest("hex") === sha256) {
        return { kind: "found", attachmentKey: child.key };
      }
    }
    return { kind: "absent" };
  }

  async setUrlAndAccessDate(itemKey: string, url: string, accessedAt: string): Promise<void> {
    const fields = { url, accessDate: zoteroDateTime(accessedAt) };
    await this.post(
      "/write",
      { operation: "update_item_fields", item_key: itemKey, fields },
      UpdateItemFieldsSchema,
    );
  }

  // Stores the bytes as a child attachment of the item; answers the attachment's key.
  async attachBytes(itemKey: string, fileName: string, title: string, bytes: Uint8Array) {
    const body = {
      item_key: itemKey,
      title,
      file_name: fileName,
      file_bytes_base64: Buffer.from(bytes).toString("base64"),
    };
    return (await this.post("/attach", body, AttachSchema)).attachment_key;
  }
}
