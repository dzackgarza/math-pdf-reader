// The index export: every stored item's embedded provenance with its filing, plus the
// collections and saved searches, as one deterministic JSON document (items in key order).
// Importing it into a store without filing restores collections, tags, notes and saved
// searches; rebuilding from it re-downloads every PDF it lists that the store has lost.
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Semaphore } from "async-mutex";
import { z } from "zod";
import type { AppConfig } from "./config";
import { ProvenanceSchema } from "./contract";
import { CollectionSchema, SavedSearchSchema } from "./libraryContract";
import {
  ItemFilingSchema,
  type Organization,
  OrganizationStore,
  organizationFile,
  unfiled,
} from "./organization";
import { listItems, restorePdf, storedPdfPath } from "./store";

const ExportedItemSchema = z.strictObject({
  key: z.string().min(1),
  provenance: ProvenanceSchema,
  filing: ItemFilingSchema,
});

export const IndexExportSchema = z.strictObject({
  version: z.literal(1),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  items: z.array(ExportedItemSchema),
});

export type IndexExport = z.infer<typeof IndexExportSchema>;
type ExportedItem = z.infer<typeof ExportedItemSchema>;

export type RebuildOutcome =
  | { key: string; status: "present" }
  | { key: string; status: "restored"; stored_sha256: string }
  | { key: string; status: "dead"; pdf_url: string; reason: string }
  | {
      key: string;
      status: "changed";
      pdf_url: string;
      expected_sha256: string;
      observed_sha256: string;
    };

export type RebuildSettings = AppConfig["rebuild"];

// The previous export lists items the store no longer holds. Writing a new export would drop
// the only record that can bring them back.
export class PdfsMissingError extends Error {
  constructor(
    readonly keys: string[],
    exportFile: string,
  ) {
    super(
      `${exportFile} lists ${keys.join(", ")}, which have no PDF in the store; run \`just rebuild-cache\` first`,
    );
  }
}

// Importing would overwrite filing the store already has.
export class FilingExistsError extends Error {
  constructor(root: string) {
    super(`${organizationFile(root)} exists; import only into a store without filing`);
  }
}

export async function readIndexExport(exportFile: string): Promise<IndexExport> {
  return IndexExportSchema.parse(JSON.parse(await readFile(exportFile, "utf8")));
}

export async function exportIndex(root: string, exportFile: string): Promise<IndexExport> {
  const stored = await listItems(root, []);
  if (existsSync(exportFile)) {
    const keys = new Set(stored.map((item) => item.key));
    const previous = await readIndexExport(exportFile);
    const missing = previous.items.map((item) => item.key).filter((key) => !keys.has(key));
    if (missing.length > 0) {
      throw new PdfsMissingError(missing, exportFile);
    }
  }
  const organization = await new OrganizationStore(root).read();
  const index: IndexExport = {
    version: 1,
    collections: organization.collections,
    savedSearches: organization.savedSearches,
    items: stored.map(({ key, provenance }) => ({
      key,
      provenance,
      filing: organization.items[key] ?? unfiled(provenance.captured_at),
    })),
  };
  mkdirSync(dirname(exportFile), { recursive: true });
  const partial = `${exportFile}.partial`;
  await writeFile(partial, `${JSON.stringify(index, null, 2)}\n`);
  await rename(partial, exportFile);
  return index;
}

export async function importIndex(root: string, exportFile: string): Promise<Organization> {
  mkdirSync(root, { recursive: true });
  if (existsSync(organizationFile(root))) {
    throw new FilingExistsError(root);
  }
  const index = await readIndexExport(exportFile);
  // The export gives every item a filing; one never filed is exported as `unfiled`, which the
  // library assumes for an item the filing document omits, so it is omitted again here.
  const filed = index.items.filter(
    ({ provenance, filing }) => !Bun.deepEquals(filing, unfiled(provenance.captured_at)),
  );
  return new OrganizationStore(root).update(() => ({
    version: 1,
    collections: index.collections,
    savedSearches: index.savedSearches,
    items: Object.fromEntries(filed.map((item) => [item.key, item.filing])),
  }));
}

type Download = { bytes: Uint8Array<ArrayBuffer> } | { failure: string };

// The one boundary where a network rejection becomes a dead-URL outcome.
async function download(url: string, timeoutSeconds: number): Promise<Download> {
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  const response = await fetch(url, { signal }).then(
    (answer) => answer,
    (error: Error) => error,
  );
  if (response instanceof Error) {
    return { failure: response.message };
  }
  if (!response.ok) {
    return { failure: `HTTP ${response.status}` };
  }
  return response.arrayBuffer().then(
    (body) => ({ bytes: new Uint8Array(body) }),
    (error: Error) => ({ failure: error.message }),
  );
}

async function rebuildItem(
  root: string,
  item: ExportedItem,
  settings: RebuildSettings,
): Promise<RebuildOutcome> {
  const { key, provenance } = item;
  if (storedPdfPath(root, key) !== null) {
    return { key, status: "present" };
  }
  const fetched = await download(provenance.pdf_url, settings.download_timeout_seconds);
  if ("failure" in fetched) {
    return { key, status: "dead", pdf_url: provenance.pdf_url, reason: fetched.failure };
  }
  const observed = new Bun.CryptoHasher("sha256").update(fetched.bytes).digest("hex");
  if (observed !== provenance.original_sha256) {
    return {
      key,
      status: "changed",
      pdf_url: provenance.pdf_url,
      expected_sha256: provenance.original_sha256,
      observed_sha256: observed,
    };
  }
  const restored = await restorePdf(root, key, fetched.bytes, provenance);
  return { key, status: "restored", stored_sha256: restored.stored_sha256 };
}

// Every item the export lists, in export order: present, restored, or reported by key.
export async function rebuildCache(
  root: string,
  exportFile: string,
  settings: RebuildSettings,
): Promise<RebuildOutcome[]> {
  mkdirSync(root, { recursive: true });
  const index = await readIndexExport(exportFile);
  const downloads = new Semaphore(settings.concurrent_downloads);
  return Promise.all(
    index.items.map((item) => downloads.runExclusive(() => rebuildItem(root, item, settings))),
  );
}
