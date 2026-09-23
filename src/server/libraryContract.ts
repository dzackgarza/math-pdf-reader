// The library API contract: what `/api/library` and the filing mutations send and accept.
// Shared by the server and the library UI, so it imports nothing server-side.
import { z } from "zod";

export const ProvenanceSchema = z.strictObject({
  pdf_url: z.url(),
  source_url: z.url(),
  captured_at: z.iso.datetime({ offset: true }),
  original_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  title_hint: z.string().min(1),
});

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

// The library item: title, url, tags, collections, notes and dates carry the same meaning
// as in a reference-manager item; provenance, file and extraction are the bucket's own.
export const BucketItemSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  tags: z.array(z.string().min(1)),
  collections: z.array(z.string().min(1)),
  notes: z.array(ItemNoteSchema),
  dateAdded: z.iso.datetime({ offset: true }),
  dateModified: z.iso.datetime({ offset: true }),
  provenance: ProvenanceSchema,
  file: z.strictObject({ path: z.string().min(1), sizeBytes: z.number().int().nonnegative() }),
  extraction: ExtractionSchema,
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
