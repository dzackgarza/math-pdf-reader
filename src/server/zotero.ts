// The Zotero local write API: the endpoints the local-write-api addon adds to Zotero's own
// HTTP server (`POST /write` with an `operation`, `POST /attach`). The send action is the
// only caller; nothing else in the bucket writes to Zotero.
import { z } from "zod";

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

const UpdateItemFieldsSchema = z.object({
  success: z.literal(true),
  operation: z.literal("update_item_fields"),
  details: z.object({ item_key: z.string().min(1) }),
});

const AttachSchema = z.object({
  success: z.literal(true),
  attachment_key: z.string().min(1),
});

// Zotero stores dates as UTC `YYYY-MM-DD HH:MM:SS`.
export function zoteroDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
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
