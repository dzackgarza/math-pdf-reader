// The library API contract: what `/api/library` and the filing mutations send and accept.
// Shared by the server and the library UI, so it imports nothing server-side.
import { z } from "zod";
import { ProvenanceSchema, RetrieveMetadataOutcomeSchema } from "./capture";
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
export const CONTAINS_OPERATORS = ["contains", "does not contain"] as const;
export const IS_OPERATORS = ["is", "is not"] as const;
const containsRule = <F extends string>(field: F) =>
  z.strictObject({
    field: z.literal(field),
    operator: z.enum(CONTAINS_OPERATORS),
    value: TrimmedSchema,
  });
const isRule = <F extends string>(field: F) =>
  z.strictObject({
    field: z.literal(field),
    operator: z.enum(IS_OPERATORS),
    value: TrimmedSchema,
  });
export const READING_STATES = ["unread", "reading", "finished"] as const;
// Whether an item's PDF can still be fetched from where it came from.
export const AVAILABILITIES = ["cached", "offline"] as const;
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
    operator: z.enum(IS_OPERATORS),
    value: z.enum(READING_STATES),
  }),
  z.strictObject({
    field: z.literal("status"),
    operator: z.enum(IS_OPERATORS),
    value: z.enum(AVAILABILITIES),
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
export const MirrorSchema = z.strictObject({
  url: HttpUrlSchema,
  check: SourceCheckSchema,
});

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

// The steps of a send once the Zotero item exists: set its URL and access date, attach the
// bucket's PDF, attach the extraction Markdown when the item has one, and add each of the
// item's notes as a Zotero child note. `notes` is owed while any note has no `note` step.
export const SEND_STEPS = ["fields", "pdf", "markdown", "notes"] as const;

export const SendStepSchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("fields") }),
  z.strictObject({ step: z.literal("pdf"), attachmentKey: NonEmptySchema }),
  z.strictObject({
    step: z.literal("markdown"),
    attachmentKey: NonEmptySchema,
  }),
  z.strictObject({
    step: z.literal("note"),
    noteId: NonEmptySchema,
    noteKey: NonEmptySchema,
  }),
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

// The Zotero item a send goes to, and the steps done on it so far.
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
// `created`: this send made the Zotero item; false when it finished an earlier send, or found
// the work already in Zotero (by its DOI, or by the page URL a send writes) and sent to that item.
// `kept`: the item stays in the bucket because a collection holding it keeps its items offline.
export const SendResponseSchema = z.strictObject({
  itemKey: NonEmptySchema,
  created: z.boolean(),
  performed: z.array(z.enum(SEND_STEPS)),
  kept: z.boolean(),
});

// Where an item's title came from: a manual edit, a resolver, an inference, the PDF,
// the capture hint, or the file name.
export const TITLE_SOURCES = [
  "manual",
  "resolver",
  "guess",
  "pdf-metadata",
  "capture-hint",
  "filename",
] as const;

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
  // The item's URL, as a reference manager's URL field: the page the PDF was linked from, or
  // the PDF's own URL when no linking page is known.
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
  file: z.strictObject({
    path: NonEmptySchema,
    sizeBytes: z.number().int().nonnegative(),
  }),
  extraction: ExtractionSchema,
  zotero: ZoteroStatusSchema,
});

export const RetrieveMetadataResponseSchema = z.strictObject({
  outcome: RetrieveMetadataOutcomeSchema,
  item: BucketItemSchema,
});

export const ManualMetadataRequestSchema = z.strictObject({
  title: TrimmedSchema,
  authors: z.array(TrimmedSchema),
  year: z.int().nullable(),
  abstract: TrimmedSchema.nullable(),
});

export const MetadataGuessSchema = z.strictObject({
  title: NonEmptySchema,
  authors: z.array(NonEmptySchema).min(1),
  year: z.int(),
});

export const GuessMetadataProviderSchema = z.enum(["gemini", "ollama"]);

export const GuessMetadataResultSchema = z.strictObject({
  provider: GuessMetadataProviderSchema,
  model: NonEmptySchema,
  metadata: MetadataGuessSchema,
});

export const GuessMetadataResponseSchema = GuessMetadataResultSchema.extend({
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
    .array(
      z.strictObject({
        page: z.int().min(1),
        seconds: z.number().min(MIN_PAGE_SECONDS),
      }),
    )
    .min(1),
});

// A stored session carries the item as it was when read, so the timeline outlives the item.
export const ReadingSessionSchema = ReadingSessionReportSchema.extend({
  item: z.strictObject({
    title: NonEmptySchema,
    authors: z.array(NonEmptySchema),
    year: z.int().nullable(),
    abstract: NonEmptySchema.nullable(),
    // The item's URL: its source page, or its PDF URL when no page is known.
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
  // Files named `<key>.pdf` in the root that the store cannot read (torn, foreign, without
  // the bucket's provenance): the library lists every other item and names these.
  unreadable: z.array(z.strictObject({ file: NonEmptySchema, message: NonEmptySchema })),
});

// What Rebuild did for one item: its PDF was there; it was downloaded again from the PDF URL
// or a mirror and matched the recorded original; every URL was tried and none served it; or
// the rebuild failed in the bucket itself (the store could not write the PDF).
// A restored PDF's metadata: the title and authors a resolver gave, recorded again; none to
// record, since the item's title was read from the PDF; or a recording that failed, which
// leaves the PDF restored with the title it carries.
export const RebuildOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ key: NonEmptySchema, status: z.literal("present") }),
  z.strictObject({
    key: NonEmptySchema,
    status: z.literal("restored"),
    from: z.url(),
    stored_sha256: Sha256Schema,
    metadata: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("recorded") }),
      z.strictObject({ status: z.literal("from_pdf") }),
      z.strictObject({ status: z.literal("failed"), message: NonEmptySchema }),
    ]),
  }),
  z.strictObject({
    key: NonEmptySchema,
    status: z.literal("failed"),
    message: NonEmptySchema,
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
// `metadata` as in a capture: the resolvers' outcome for a new PDF, null for one already stored.
export const ImportUrlResponseSchema = z.strictObject({
  key: NonEmptySchema,
  existing: z.boolean(),
  metadata: RetrieveMetadataOutcomeSchema.nullable(),
});

// Add Folder: one outcome per file directly inside the folder whose name ends in `.pdf`, in
// name order: stored under a new key, already held, not a PDF (no `%PDF-` header), or failed
// in the store. One file's failure never discards the others'.
export const FolderImportRequestSchema = z.strictObject({
  path: NonEmptySchema,
});
export const FolderImportResponseSchema = z.strictObject({
  files: z.array(
    z.discriminatedUnion("status", [
      z.strictObject({
        file: NonEmptySchema,
        status: z.literal("stored"),
        key: NonEmptySchema,
        metadata: RetrieveMetadataOutcomeSchema,
      }),
      z.strictObject({
        file: NonEmptySchema,
        status: z.literal("existing"),
        key: NonEmptySchema,
      }),
      z.strictObject({ file: NonEmptySchema, status: z.literal("not_a_pdf") }),
      z.strictObject({
        file: NonEmptySchema,
        status: z.literal("failed"),
        message: NonEmptySchema,
      }),
    ]),
  ),
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
  "metadata_guess_failed",
  "zotero_failed",
  "storage_check_failed",
  // The store could not do its work: a write failed, or its pikepdf command failed.
  "store_failed",
  // A PDF the store cannot read (torn, encrypted, not a PDF inside).
  "unreadable_pdf",
  // Bytes that carry no `%PDF-` header in their first 1024 bytes.
  "not_a_pdf",
  // A reader save whose If-Match names bytes the stored file no longer holds (HTTP 412).
  "stale_pdf",
  // A plugin that exited 0 without writing what its contract names.
  "plugin_contract_broken",
  // A fault in the bucket itself.
  "internal",
  "cross_origin_request",
  "unsupported_media_type",
] as const;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    kind: z.enum(API_ERROR_KINDS),
    message: NonEmptySchema,
  }),
});

// Request bodies.
export const NoteRequestSchema = z.strictObject({ note: TrimmedSchema });
// A filing change to every item listed: `remove` is taken away first, then `add` goes after
// what each item keeps. Either array may be empty.
const BulkKeysSchema = z.array(NonEmptySchema).min(1);
export const BulkTagsRequestSchema = z.strictObject({
  keys: BulkKeysSchema,
  add: z.array(TrimmedSchema),
  remove: z.array(TrimmedSchema),
});
export const BulkCollectionsRequestSchema = z.strictObject({
  keys: BulkKeysSchema,
  add: z.array(NonEmptySchema),
  remove: z.array(NonEmptySchema),
});
export const NewCollectionRequestSchema = z.strictObject({
  name: NameSchema,
  parentId: NonEmptySchema.optional(),
});
// A partial update names at least one field: the refinement checks it in TypeScript, and the
// `minProperties` it carries into the JSON Schema checks it in the server.
function changingSomething<T extends z.ZodObject>(update: T) {
  return update
    .refine((fields) => Object.keys(fields).length > 0, "the update changes nothing")
    .meta({ minProperties: 1 });
}
// Any of a collection's own fields; the others stay as they are.
export const CollectionUpdateRequestSchema = changingSomething(
  z
    .strictObject({
      name: NameSchema,
      description: z.string(),
      pinned: z.boolean(),
      keepOffline: z.boolean(),
    })
    .partial(),
);
// Any of the preferences; the others stay as they are.
export const PreferencesUpdateRequestSchema = changingSomething(PreferencesSchema.partial());
export const NewSavedSearchRequestSchema = SavedSearchSchema.omit({ id: true });
export const SavedSearchUpdateRequestSchema = SavedSearchSchema.omit({
  id: true,
});

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
export type ManualMetadataRequest = z.infer<typeof ManualMetadataRequestSchema>;
export type GuessMetadataResponse = z.infer<typeof GuessMetadataResponseSchema>;

// The session-storage key under which the library page keeps its current view (the address's
// hash, e.g. `#/unfiled`); the reader's Library button returns to that view.
export const LIBRARY_VIEW_KEY = "pdf-bucket.library-view";
// The same key as a schema, so the server's reader page gets it from the generated contract.
export const LibraryViewKeySchema = z.literal(LIBRARY_VIEW_KEY);
