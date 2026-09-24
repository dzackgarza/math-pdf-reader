// The library API contract: what `/api/library` and the filing mutations send and accept.
// Shared by the server and the library UI, so it imports nothing server-side.
import { z } from "zod";
import { ProvenanceSchema } from "./contract";

export const SEARCH_FIELDS = ["title", "source", "pdfUrl", "tags", "notes", "key"] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

export const AdvancedSearchSettingsSchema = z.strictObject({
  query: z.string(),
  matchCase: z.boolean(),
  matchType: z.enum(["all", "any"]),
  searchFields: z.record(z.enum(SEARCH_FIELDS), z.boolean()),
});

const NameSchema = z.string().trim().min(1);

export const CollectionSchema = z.strictObject({
  id: z.string().min(1),
  name: NameSchema,
  parentId: z.string().min(1).optional(),
});

export const SavedSearchSchema = z.strictObject({
  id: z.string().min(1),
  name: NameSchema,
  search: AdvancedSearchSettingsSchema,
});

// How far an item has been read: never opened, or the page the reader last showed out of the
// document's page count.
export const ReadingSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unread") }),
  z.strictObject({
    status: z.literal("viewed"),
    page: z.int().min(1),
    pages: z.int().min(1),
    viewedAt: z.iso.datetime({ offset: true }),
  }),
]);

export const ReadingRequestSchema = z
  .strictObject({ page: z.int().min(1), pages: z.int().min(1) })
  .refine((reading) => reading.page <= reading.pages, "page lies beyond the page count");

export const ItemNoteSchema = z.strictObject({
  id: z.string().min(1),
  note: z.string().trim().min(1),
  dateAdded: z.iso.datetime({ offset: true }),
  dateModified: z.iso.datetime({ offset: true }),
});

// A file an extraction plugin left beside the stored PDF: `name` is the Markdown's file
// name, or an artifact's path inside `<key>.extraction/`.
const ArtifactSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

// An item's extraction, derived from the files beside its PDF and never stored elsewhere:
// `<key>.md` is the Markdown and marks a complete extraction (the runner writes it last);
// `<key>.extraction/` holds the further artifacts. No Markdown means no extraction.
export const ExtractionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({
    status: z.literal("extracted"),
    markdown: ArtifactSchema,
    files: z.array(ArtifactSchema),
  }),
]);

// The steps of a send after Zotero has created the item: set its URL and access date, attach
// the PDF, attach the extraction Markdown when the item has one.
export const SEND_STEPS = ["fields", "pdf", "markdown"] as const;

export const SendStepSchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("fields") }),
  z.strictObject({ step: z.literal("pdf"), attachmentKey: z.string().min(1) }),
  z.strictObject({ step: z.literal("markdown"), attachmentKey: z.string().min(1) }),
]);

// How the Zotero item's metadata was found: a resolver plugin on an identifier, or, for an
// item with no identifier, a manuscript entry carrying only the title.
export const SendSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("resolver"),
    pluginId: z.string().min(1),
    identifier: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("manuscript") }),
]);

// The Zotero item a send created, and the steps done on it so far.
export const ZoteroRecordSchema = z.strictObject({
  itemKey: z.string().min(1),
  sentAt: z.iso.datetime({ offset: true }),
  source: SendSourceSchema,
  steps: z.array(SendStepSchema),
});

// `pending` lists the steps still owed: a send that failed part way, or an extraction made
// after the send, leaves steps a later send completes.
export const ZoteroStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unsent") }),
  z.strictObject({
    status: z.literal("sent"),
    record: ZoteroRecordSchema,
    pending: z.array(z.enum(SEND_STEPS)),
  }),
]);

// The answer to a send: the Zotero item and the steps this send performed.
export const SendResponseSchema = z.strictObject({
  itemKey: z.string().min(1),
  created: z.boolean(),
  performed: z.array(z.enum(SEND_STEPS)),
});

// Where an item's title came from, best first: an identifier resolver, the PDF's own
// metadata, the title the capture offered (link text, page title), the stored file's name.
export const TITLE_SOURCES = ["resolver", "pdf-metadata", "capture-hint", "filename"] as const;

export const TitleSourceSchema = z.enum(TITLE_SOURCES);

// The library item: title, url, tags, collections, notes and dates carry the same meaning
// as in a reference-manager item; provenance, file and extraction are the bucket's own.
export const BucketItemSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  titleSource: TitleSourceSchema,
  authors: z.array(z.string().min(1)),
  url: z.url(),
  tags: z.array(z.string().min(1)),
  collections: z.array(z.string().min(1)),
  notes: z.array(ItemNoteSchema),
  reading: ReadingSchema,
  dateAdded: z.iso.datetime({ offset: true }),
  dateModified: z.iso.datetime({ offset: true }),
  provenance: ProvenanceSchema,
  file: z.strictObject({ path: z.string().min(1), sizeBytes: z.number().int().nonnegative() }),
  extraction: ExtractionSchema,
  zotero: ZoteroStatusSchema,
});

// The outcome of "Retrieve metadata": the resolver that answered and the title it gave; no
// identifier the resolvers know; or the resolver that failed, whose failure leaves the
// item's title as it was.
export const RetrieveMetadataOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("resolved"),
    pluginId: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string().min(1),
  }),
  z.strictObject({ status: z.literal("unidentified") }),
  z.strictObject({
    status: z.literal("failed"),
    pluginId: z.string().min(1),
    identifier: z.string().min(1),
    message: z.string().min(1),
  }),
]);

export const RetrieveMetadataResponseSchema = z.strictObject({
  outcome: RetrieveMetadataOutcomeSchema,
  item: BucketItemSchema,
});

export const LibraryPayloadSchema = z.strictObject({
  items: z.array(BucketItemSchema),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
});

export const API_ERROR_KINDS = [
  "invalid_request",
  "unknown_item",
  "unknown_collection",
  "unknown_note",
  "unknown_saved_search",
  "unknown_plugin",
  "already_sent",
  "provenance_mismatch",
  "resolver_failed",
  "zotero_failed",
] as const;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({ kind: z.enum(API_ERROR_KINDS), message: z.string().min(1) }),
});

// Request bodies.
export const TagsRequestSchema = z.strictObject({ tags: z.array(z.string().trim().min(1)) });
export const CollectionsRequestSchema = z.strictObject({ collections: z.array(z.string().min(1)) });
export const NoteRequestSchema = z.strictObject({ note: z.string().trim().min(1) });
export const NewCollectionRequestSchema = CollectionSchema.omit({ id: true });
export const RenameCollectionRequestSchema = z.strictObject({ name: NameSchema });
export const NewSavedSearchRequestSchema = SavedSearchSchema.omit({ id: true });

export const SettingsSchema = z.strictObject({
  root: z.string().min(1),
  organizationFile: z.string().min(1),
  pdfjsVersion: z.string().min(1),
});

// The collection and every collection below it.
export function collectionSubtree(collections: Collection[], id: string): Set<string> {
  const subtree = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const collection of collections) {
      const below = collection.parentId !== undefined && subtree.has(collection.parentId);
      if (below && !subtree.has(collection.id)) {
        subtree.add(collection.id);
        grew = true;
      }
    }
  }
  return subtree;
}

// Topics are tags in this namespace; the library shows them without the prefix.
export const TOPIC_PREFIX = "topic:";

export type Provenance = z.infer<typeof ProvenanceSchema>;
export type AdvancedSearchSettings = z.infer<typeof AdvancedSearchSettingsSchema>;
export type Collection = z.infer<typeof CollectionSchema>;
export type SavedSearch = z.infer<typeof SavedSearchSchema>;
export type ItemNote = z.infer<typeof ItemNoteSchema>;
export type BucketItem = z.infer<typeof BucketItemSchema>;
export type LibraryPayload = z.infer<typeof LibraryPayloadSchema>;
export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];
export type Settings = z.infer<typeof SettingsSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;
export type SendStep = (typeof SEND_STEPS)[number];
export type SendStepDone = z.infer<typeof SendStepSchema>;
export type SendSource = z.infer<typeof SendSourceSchema>;
export type ZoteroRecord = z.infer<typeof ZoteroRecordSchema>;
export type ZoteroStatus = z.infer<typeof ZoteroStatusSchema>;
export type SendResponse = z.infer<typeof SendResponseSchema>;
export type TitleSource = z.infer<typeof TitleSourceSchema>;
export type Reading = z.infer<typeof ReadingSchema>;
export type RetrieveMetadataOutcome = z.infer<typeof RetrieveMetadataOutcomeSchema>;
export type RetrieveMetadataResponse = z.infer<typeof RetrieveMetadataResponseSchema>;

// The session-storage key under which the library page keeps its current view (the address's
// hash, e.g. `#/unfiled`); the reader's Library button returns to that view.
export const LIBRARY_VIEW_KEY = "pdf-bucket.library-view";
