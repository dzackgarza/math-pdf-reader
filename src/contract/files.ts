// The documents the bucket keeps beside the stored PDFs: the filing (`organization.json`), the
// reading sessions (`reading-sessions.json`), the keys removed on purpose (`removed.json`), and
// the index export that can rebuild them.
// None of them holds the only copy of provenance: deleting them leaves every stored PDF with its own.
import { z } from "zod";
import {
  ActivitySchema,
  CollectionSchema,
  ItemNoteSchema,
  MirrorSchema,
  PreferencesSchema,
  ReadingSchema,
  ReadingSessionSchema,
  SavedSearchSchema,
  SourceCheckSchema,
  ZoteroRecordSchema,
} from "./library";
import { StoredItemSchema } from "./store";
import { NonEmptySchema } from "./text";

export const ItemFilingSchema = z.strictObject({
  tags: z.array(NonEmptySchema),
  collections: z.array(NonEmptySchema),
  notes: z.array(ItemNoteSchema),
  reading: ReadingSchema,
  // The last check of the PDF URL, and the item's mirrors with theirs.
  sourceCheck: SourceCheckSchema,
  mirrors: z.array(MirrorSchema),
  modifiedAt: z.iso.datetime({ offset: true }),
  // Present once a send has created the item in Zotero.
  zotero: ZoteroRecordSchema.optional(),
});

// Collections, saved searches and each item's filing, keyed by item key.
export const OrganizationSchema = z.strictObject({
  version: z.literal(2),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  items: z.record(NonEmptySchema, ItemFilingSchema),
  // Filing changes per collection, oldest first; the server keeps the latest 500.
  activity: z.array(ActivitySchema),
  preferences: PreferencesSchema,
});

export const SessionsSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(ReadingSessionSchema),
});

// Keys the user took out of the bucket on purpose (a delete, a send to Zotero, forgetting a
// missing item). The key is recorded before its PDF goes, so an index export that still lists it
// drops it instead of refusing, across a restart too; a key leaves once an export has dropped it
// or a new capture takes it.
export const RemovedKeysSchema = z.strictObject({
  version: z.literal(1),
  keys: z.array(NonEmptySchema),
});

// A file an extraction left beside the stored PDF, by its name under the bucket root.
const ExtractionFileRecordSchema = z.strictObject({
  name: NonEmptySchema,
  sizeBytes: z.int().nonnegative(),
});

// What an item's extraction left in the bucket when the export was written: the Markdown
// (`<key>.md`) and the artifacts under `<key>.extraction/`.
export const ExtractionRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({
    status: z.literal("extracted"),
    markdown: ExtractionFileRecordSchema,
    files: z.array(ExtractionFileRecordSchema),
  }),
]);

// A stored item as the export holds it: what its PDF carries, its filing, and its extraction.
export const ExportedItemSchema = StoredItemSchema.extend({
  filing: ItemFilingSchema,
  extraction: ExtractionRecordSchema,
});

// Every stored item's embedded provenance with its filing and extraction record, plus the
// collections, saved searches and reading sessions, as one deterministic JSON document (items in
// key order).
export const IndexExportSchema = z.strictObject({
  version: z.literal(3),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  activity: z.array(ActivitySchema),
  preferences: PreferencesSchema,
  sessions: z.array(ReadingSessionSchema),
  items: z.array(ExportedItemSchema),
});

export type ItemFiling = z.infer<typeof ItemFilingSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Sessions = z.infer<typeof SessionsSchema>;
export type RemovedKeys = z.infer<typeof RemovedKeysSchema>;
export type ExtractionRecord = z.infer<typeof ExtractionRecordSchema>;
export type ExportedItem = z.infer<typeof ExportedItemSchema>;
export type IndexExport = z.infer<typeof IndexExportSchema>;
