// The documents the bucket keeps beside the stored PDFs: the filing (`organization.json`), the
// reading sessions (`reading-sessions.json`), and the index export that can rebuild both.
// Provenance never lives in these: deleting them leaves every stored PDF and its provenance.
import { z } from "zod";
import { ProvenanceSchema } from "./capture";
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
  TitleSourceSchema,
  ZoteroRecordSchema,
} from "./library";
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

export const ExportedItemSchema = z.strictObject({
  key: NonEmptySchema,
  provenance: ProvenanceSchema,
  title: z.strictObject({ text: NonEmptySchema, source: TitleSourceSchema }),
  authors: z.array(NonEmptySchema),
  year: z.int().nullable(),
  abstract: NonEmptySchema.nullable(),
  filing: ItemFilingSchema,
});

// Every stored item's embedded provenance with its filing, plus the collections and saved
// searches, as one deterministic JSON document (items in key order).
export const IndexExportSchema = z.strictObject({
  version: z.literal(2),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  activity: z.array(ActivitySchema),
  preferences: PreferencesSchema,
  items: z.array(ExportedItemSchema),
});

export type ItemFiling = z.infer<typeof ItemFilingSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Sessions = z.infer<typeof SessionsSchema>;
export type ExportedItem = z.infer<typeof ExportedItemSchema>;
export type IndexExport = z.infer<typeof IndexExportSchema>;
