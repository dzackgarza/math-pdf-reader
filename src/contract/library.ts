// The library API contract: what `/api/library` and the filing mutations send and accept.
// Shared by the server and the library UI, so it imports nothing server-side.
import { z } from "zod";
import { ProvenanceSchema } from "./capture";
import { NonEmptySchema, Sha256Schema, TrimmedSchema } from "./text";

export const SEARCH_FIELDS = ["title", "source", "pdfUrl", "tags", "notes", "key"] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

export const AdvancedSearchSettingsSchema = z.strictObject({
  query: z.string(),
  matchCase: z.boolean(),
  matchType: z.enum(["all", "any"]),
  searchFields: z.record(z.enum(SEARCH_FIELDS), z.boolean()),
});

const NameSchema = TrimmedSchema;

// A collection: its name, its parent (a subcollection), a description, whether it is pinned
// to the front of the collections, and whether its items stay in the bucket after a send to
// Zotero (Keep offline).
export const CollectionSchema = z.strictObject({
  id: NonEmptySchema,
  name: NameSchema,
  parentId: NonEmptySchema.optional(),
  description: z.string(),
  pinned: z.boolean(),
  keepOffline: z.boolean(),
});

// A filing change that concerns a collection, for its recent activity: its creation, items
// filed into it, items in it tagged, Keep offline switched.
export const ActivitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("created"),
    at: z.iso.datetime({ offset: true }),
    collectionId: NonEmptySchema,
  }),
  z.strictObject({
    kind: z.literal("filed"),
    at: z.iso.datetime({ offset: true }),
    collectionId: NonEmptySchema,
    count: z.int().min(1),
  }),
  z.strictObject({
    kind: z.literal("tagged"),
    at: z.iso.datetime({ offset: true }),
    collectionId: NonEmptySchema,
    count: z.int().min(1),
    tags: z.array(NonEmptySchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("keptOffline"),
    at: z.iso.datetime({ offset: true }),
    collectionId: NonEmptySchema,
    on: z.boolean(),
  }),
]);

// One condition of a saved search (a smart collection). `text` is the filter bar's search;
// the others test one field of the item.
const TextRule = z.strictObject({
  field: z.literal("text"),
  operator: z.literal("matches"),
  search: AdvancedSearchSettingsSchema,
});
const containsRule = <F extends string>(field: F) =>
  z.strictObject({
    field: z.literal(field),
    operator: z.enum(["contains", "does not contain"]),
    value: TrimmedSchema,
  });
const isRule = <F extends string>(field: F) =>
  z.strictObject({
    field: z.literal(field),
    operator: z.enum(["is", "is not"]),
    value: TrimmedSchema,
  });
export const READING_STATES = ["unread", "reading", "finished"] as const;
export const RuleSchema = z.discriminatedUnion("field", [
  TextRule,
  containsRule("title"),
  containsRule("author"),
  isRule("tag"),
  isRule("topic"),
  // The value is a collection id; the rule holds for its subcollections too.
  isRule("collection"),
  // The value is a source domain, as the table's Source column shows it.
  isRule("source"),
  z.strictObject({
    field: z.literal("added"),
    operator: z.literal("within days"),
    value: z.int().min(1),
  }),
  z.strictObject({
    field: z.literal("reading"),
    operator: z.enum(["is", "is not"]),
    value: z.enum(READING_STATES),
  }),
  z.strictObject({
    field: z.literal("status"),
    operator: z.enum(["is", "is not"]),
    value: z.enum(["cached", "offline"]),
  }),
]);

export const RULE_FIELDS = RuleSchema.options.map((option) => option.shape.field.value);

// A saved search: its rules, all of which or any of which an item must meet.
export const SavedSearchSchema = z.strictObject({
  id: NonEmptySchema,
  name: NameSchema,
  match: z.enum(["all", "any"]),
  rules: z.array(RuleSchema).min(1),
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

// Whether a URL still serves the captured PDF: never checked; the same bytes (accessible);
// other bytes (changed); or no PDF at all (dead), with the HTTP status or network error.
export const SOURCE_RESULTS = ["accessible", "changed", "dead"] as const;

const checkedAs = <S extends (typeof SOURCE_RESULTS)[number]>(status: S) =>
  z.strictObject({
    status: z.literal(status),
    checkedAt: z.iso.datetime({ offset: true }),
    detail: z.string(),
  });

export const SourceCheckSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unchecked") }),
  checkedAs("accessible"),
  checkedAs("changed"),
  checkedAs("dead"),
]);

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

// Another URL that serves the same PDF; Rebuild tries mirrors after the PDF URL.
export const MirrorSchema = z.strictObject({ url: HttpUrlSchema, check: SourceCheckSchema });

export const MirrorRequestSchema = z.strictObject({ url: HttpUrlSchema });

export const ItemNoteSchema = z.strictObject({
  id: NonEmptySchema,
  note: TrimmedSchema,
  dateAdded: z.iso.datetime({ offset: true }),
  dateModified: z.iso.datetime({ offset: true }),
});

// A file an extraction plugin left beside the stored PDF: `name` is the Markdown's file
// name, or an artifact's path inside `<key>.extraction/`.
const ArtifactSchema = z.strictObject({
  name: NonEmptySchema,
  path: NonEmptySchema,
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
  z.strictObject({ step: z.literal("pdf"), attachmentKey: NonEmptySchema }),
  z.strictObject({ step: z.literal("markdown"), attachmentKey: NonEmptySchema }),
]);

// How the Zotero item's metadata was found: a resolver plugin on an identifier, or, for an
// item with no identifier, a manuscript entry carrying only the title.
export const SendSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("resolver"),
    pluginId: NonEmptySchema,
    identifier: NonEmptySchema,
  }),
  z.strictObject({ kind: z.literal("manuscript") }),
]);

// The Zotero item a send created, and the steps done on it so far.
export const ZoteroRecordSchema = z.strictObject({
  itemKey: NonEmptySchema,
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
// `kept`: the item stays in the bucket because a collection holding it keeps its items offline.
export const SendResponseSchema = z.strictObject({
  itemKey: NonEmptySchema,
  created: z.boolean(),
  performed: z.array(z.enum(SEND_STEPS)),
  kept: z.boolean(),
});

// Where an item's title came from, best first: an identifier resolver, the PDF's own
// metadata, the title the capture offered (link text, page title), the stored file's name.
export const TITLE_SOURCES = ["resolver", "pdf-metadata", "capture-hint", "filename"] as const;

export const TitleSourceSchema = z.enum(TITLE_SOURCES);

// The library item: title, url, tags, collections, notes and dates carry the same meaning
// as in a reference-manager item; provenance, file and extraction are the bucket's own.
export const BucketItemSchema = z.strictObject({
  id: NonEmptySchema,
  title: NonEmptySchema,
  titleSource: TitleSourceSchema,
  authors: z.array(NonEmptySchema),
  // From a resolver; null when none gave them.
  year: z.int().nullable(),
  abstract: NonEmptySchema.nullable(),
  url: z.url(),
  tags: z.array(NonEmptySchema),
  collections: z.array(NonEmptySchema),
  notes: z.array(ItemNoteSchema),
  reading: ReadingSchema,
  sourceCheck: SourceCheckSchema,
  mirrors: z.array(MirrorSchema),
  dateAdded: z.iso.datetime({ offset: true }),
  dateModified: z.iso.datetime({ offset: true }),
  provenance: ProvenanceSchema,
  file: z.strictObject({ path: NonEmptySchema, sizeBytes: z.number().int().nonnegative() }),
  extraction: ExtractionSchema,
  zotero: ZoteroStatusSchema,
});

// The outcome of "Retrieve metadata": the resolver that answered and the title it gave; no
// identifier the resolvers know; or the resolver that failed, whose failure leaves the
// item's title as it was.
export const RetrieveMetadataOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("resolved"),
    pluginId: NonEmptySchema,
    identifier: NonEmptySchema,
    title: NonEmptySchema,
  }),
  z.strictObject({ status: z.literal("unidentified") }),
  z.strictObject({
    status: z.literal("failed"),
    pluginId: NonEmptySchema,
    identifier: NonEmptySchema,
    message: NonEmptySchema,
  }),
]);

export const RetrieveMetadataResponseSchema = z.strictObject({
  outcome: RetrieveMetadataOutcomeSchema,
  item: BucketItemSchema,
});

// An item the index export holds whose PDF the store has lost: what Rebuild needs to fetch it
// again and what the library shows of it meanwhile.
export const MissingItemSchema = z.strictObject({
  key: NonEmptySchema,
  title: NonEmptySchema,
  authors: z.array(NonEmptySchema),
  provenance: ProvenanceSchema,
  mirrors: z.array(HttpUrlSchema),
});

// A reading session, as the reader reports it while a PDF is open: when it opened, the last
// moment it was read (idle time excluded), and each page read, with the seconds spent on it in
// stretches of at least MIN_PAGE_SECONDS; a page scrolled past in less is not read.
export const MIN_PAGE_SECONDS = 5;

export const ReadingSessionReportSchema = z.strictObject({
  id: z.uuid(),
  key: NonEmptySchema,
  openedAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  pages: z
    .array(z.strictObject({ page: z.int().min(1), seconds: z.number().min(MIN_PAGE_SECONDS) }))
    .min(1),
});

// A stored session carries the item as it was when read, so the timeline outlives the item.
export const ReadingSessionSchema = ReadingSessionReportSchema.extend({
  item: z.strictObject({
    title: NonEmptySchema,
    authors: z.array(NonEmptySchema),
    year: z.int().nullable(),
    abstract: NonEmptySchema.nullable(),
    sourceUrl: z.url(),
  }),
});

// The colours of the library and the reader: the system's light or dark setting, or one of
// the two always.
export const THEMES = ["system", "light", "dark"] as const;
export const ThemeSchema = z.enum(THEMES);

// How the app behaves: whether the reader opens a PDF with its outline showing, and the theme.
export const PreferencesSchema = z.strictObject({
  outlineOnOpen: z.boolean(),
  theme: ThemeSchema,
});

export const LibraryPayloadSchema = z.strictObject({
  items: z.array(BucketItemSchema),
  missing: z.array(MissingItemSchema),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  activity: z.array(ActivitySchema),
  preferences: PreferencesSchema,
});

// What Rebuild did for one item: its PDF was there; it was downloaded again from the PDF URL
// or a mirror and matched the recorded original; or every URL was tried and none served it.
export const RebuildOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ key: NonEmptySchema, status: z.literal("present") }),
  z.strictObject({
    key: NonEmptySchema,
    status: z.literal("restored"),
    from: z.url(),
    stored_sha256: Sha256Schema,
  }),
  z.strictObject({
    key: NonEmptySchema,
    status: z.literal("unrestored"),
    attempts: z.array(
      z.strictObject({
        url: z.url(),
        status: z.enum(["changed", "dead"]),
        detail: z.string(),
      }),
    ),
  }),
]);

// Import URL: a PDF URL, or a page whose Highwire `citation_pdf_url` names the PDF.
export const ImportUrlRequestSchema = z.strictObject({ url: HttpUrlSchema });
export const ImportUrlResponseSchema = z.strictObject({
  key: NonEmptySchema,
  existing: z.boolean(),
});

// Add Folder: every PDF directly inside the folder; the keys newly stored and those already held.
export const FolderImportRequestSchema = z.strictObject({ path: NonEmptySchema });
export const FolderImportResponseSchema = z.strictObject({
  stored: z.array(NonEmptySchema),
  existing: z.array(NonEmptySchema),
});

export const API_ERROR_KINDS = [
  "invalid_request",
  "unknown_item",
  "unknown_collection",
  "unknown_note",
  "unknown_mirror",
  "unknown_saved_search",
  "unknown_plugin",
  "already_sent",
  "provenance_mismatch",
  "no_pdf_at_url",
  "not_a_folder",
  "folder_check_failed",
  "resolver_failed",
  "zotero_failed",
  "storage_check_failed",
] as const;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({ kind: z.enum(API_ERROR_KINDS), message: NonEmptySchema }),
});

// Request bodies.
export const TagsRequestSchema = z.strictObject({ tags: z.array(TrimmedSchema) });
export const CollectionsRequestSchema = z.strictObject({ collections: z.array(NonEmptySchema) });
export const NoteRequestSchema = z.strictObject({ note: TrimmedSchema });
// Tags or collections added to every item listed, each keeping what it had.
const BulkKeysSchema = z.array(NonEmptySchema).min(1);
export const BulkTagsRequestSchema = z.strictObject({
  keys: BulkKeysSchema,
  add: z.array(TrimmedSchema).min(1),
});
export const BulkCollectionsRequestSchema = z.strictObject({
  keys: BulkKeysSchema,
  add: z.array(NonEmptySchema).min(1),
});
export const NewCollectionRequestSchema = z.strictObject({
  name: NameSchema,
  parentId: NonEmptySchema.optional(),
});
// Any of a collection's own fields; the others stay as they are.
export const CollectionUpdateRequestSchema = z
  .strictObject({
    name: NameSchema,
    description: z.string(),
    pinned: z.boolean(),
    keepOffline: z.boolean(),
  })
  .partial()
  .refine((update) => Object.keys(update).length > 0, "the update changes nothing");
export const NewSavedSearchRequestSchema = SavedSearchSchema.omit({ id: true });
export const SavedSearchUpdateRequestSchema = SavedSearchSchema.omit({ id: true });

export const SettingsSchema = z.strictObject({
  root: NonEmptySchema,
  organizationFile: NonEmptySchema,
  pdfjsVersion: NonEmptySchema,
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
export type Rule = z.infer<typeof RuleSchema>;
export type RuleField = Rule["field"];
export type Activity = z.infer<typeof ActivitySchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type ReadingSession = z.infer<typeof ReadingSessionSchema>;
export type CollectionUpdate = z.infer<typeof CollectionUpdateRequestSchema>;
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
export type SourceCheck = z.infer<typeof SourceCheckSchema>;
export type Mirror = z.infer<typeof MirrorSchema>;
export type MissingItem = z.infer<typeof MissingItemSchema>;
export type RebuildOutcome = z.infer<typeof RebuildOutcomeSchema>;
export type ImportUrlResponse = z.infer<typeof ImportUrlResponseSchema>;
export type FolderImportResponse = z.infer<typeof FolderImportResponseSchema>;
export type RetrieveMetadataOutcome = z.infer<typeof RetrieveMetadataOutcomeSchema>;
export type RetrieveMetadataResponse = z.infer<typeof RetrieveMetadataResponseSchema>;

// The session-storage key under which the library page keeps its current view (the address's
// hash, e.g. `#/unfiled`); the reader's Library button returns to that view.
export const LIBRARY_VIEW_KEY = "pdf-bucket.library-view";
// The same key as a schema, so the server's reader page gets it from the generated contract.
export const LibraryViewKeySchema = z.literal(LIBRARY_VIEW_KEY);
