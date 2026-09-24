// The index export: every stored item's embedded provenance with its filing, plus the
// collections and saved searches, as one deterministic JSON document (items in key order).
// Importing it into a store without filing restores collections, tags, notes and saved
// searches; rebuilding from it re-downloads every PDF it lists that the store has lost.
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Semaphore } from "async-mutex";
import { z } from "zod";
import { ProvenanceSchema } from "./contract";
import {
  CollectionSchema,
  type MissingItem,
  type RebuildOutcome,
  SavedSearchSchema,
  TitleSourceSchema,
} from "./libraryContract";
import {
  ItemFilingSchema,
  type Organization,
  OrganizationStore,
  organizationFile,
  unfiled,
} from "./organization";
import { type DownloadSettings, type RecoverableItem, rebuildItem } from "./sources";
import { listItems } from "./store";

const ExportedItemSchema = z.strictObject({
  key: z.string().min(1),
  provenance: ProvenanceSchema,
  title: z.strictObject({ text: z.string().min(1), source: TitleSourceSchema }),
  authors: z.array(z.string().min(1)),
  filing: ItemFilingSchema,
});

export const IndexExportSchema = z.strictObject({
  version: z.literal(2),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  items: z.array(ExportedItemSchema),
});

export type IndexExport = z.infer<typeof IndexExportSchema>;
export type ExportedItem = z.infer<typeof ExportedItemSchema>;

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

// REMOVED names items the user deleted or sent away on purpose; the export may drop those.
export async function exportIndex(
  root: string,
  exportFile: string,
  removed: ReadonlySet<string>,
): Promise<IndexExport> {
  const stored = await listItems(root, []);
  if (existsSync(exportFile)) {
    const keys = new Set(stored.map((item) => item.key));
    const previous = await readIndexExport(exportFile);
    const missing = previous.items
      .map((item) => item.key)
      .filter((key) => !keys.has(key) && !removed.has(key));
    if (missing.length > 0) {
      throw new PdfsMissingError(missing, exportFile);
    }
  }
  const organization = await new OrganizationStore(root).read();
  const index: IndexExport = {
    version: 2,
    collections: organization.collections,
    savedSearches: organization.savedSearches,
    items: stored.map(({ key, provenance, title, authors }) => ({
      key,
      provenance,
      title,
      authors,
      filing: organization.items[key] ?? unfiled(provenance.captured_at),
    })),
  };
  mkdirSync(dirname(exportFile), { recursive: true });
  const partial = `${exportFile}.partial`;
  await writeFile(partial, `${JSON.stringify(index, null, 2)}\n`);
  await rename(partial, exportFile);
  return index;
}

// Rewrites the index export whenever the running server changes the library. Changes that
// arrive while an export runs are folded into one more export after it. A refused export (a
// PDF missing from the store) is reported on stderr and leaves the previous export in place.
export class IndexExporter {
  private running = false;
  private pending = false;
  private readonly removed = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly exportFile: string,
  ) {}

  // The items the last export holds whose PDF is not among STORED and that were not removed
  // on purpose: the ones Rebuild can bring back.
  async missing(
    stored: ReadonlySet<string>,
  ): Promise<{ item: ExportedItem; shown: MissingItem }[]> {
    if (!existsSync(this.exportFile)) {
      return [];
    }
    const index = await readIndexExport(this.exportFile);
    return index.items
      .filter((item) => !stored.has(item.key) && !this.removed.has(item.key))
      .map((item) => ({
        item,
        shown: {
          key: item.key,
          title: item.title.text,
          authors: item.authors,
          provenance: item.provenance,
          mirrors: item.filing.mirrors.map((mirror) => mirror.url),
        },
      }));
  }

  // Items removed on purpose; the next export drops them instead of refusing.
  forget(keys: string[]): void {
    for (const key of keys) {
      this.removed.add(key);
    }
  }

  changed(): void {
    this.pending = true;
    if (!this.running) {
      void this.run();
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    while (this.pending) {
      this.pending = false;
      const dropping = new Set(this.removed);
      await exportIndex(this.root, this.exportFile, dropping).then(
        () => {
          for (const key of dropping) {
            this.removed.delete(key);
          }
        },
        (error: Error) => {
          process.stderr.write(`index export refused: ${error.message}\n`);
        },
      );
    }
    this.running = false;
  }
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
    version: 2,
    collections: index.collections,
    savedSearches: index.savedSearches,
    items: Object.fromEntries(filed.map((item) => [item.key, item.filing])),
  }));
}

// Every item the export lists, in export order: present, restored, or unrestored with each
// URL tried.
export async function rebuildCache(
  root: string,
  exportFile: string,
  settings: DownloadSettings,
): Promise<RebuildOutcome[]> {
  mkdirSync(root, { recursive: true });
  const index = await readIndexExport(exportFile);
  const downloads = new Semaphore(settings.concurrent_downloads);
  return Promise.all(
    index.items.map((item) =>
      downloads.runExclusive(() => rebuildItem(root, recoverable(item), settings)),
    ),
  );
}

export function recoverable(item: ExportedItem): RecoverableItem {
  const { key, provenance, title, authors, filing } = item;
  return { key, provenance, title, authors, mirrors: filing.mirrors.map((mirror) => mirror.url) };
}
