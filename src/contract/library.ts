import { z } from "zod";
import {
  ImportMethodSchema,
  ProvenanceSchema,
  RetrieveMetadataOutcomeSchema,
} from "./capture";
import { ExtractionOutcomeSchema } from "./extraction";
import { NonEmptySchema, Sha256Schema, TrimmedSchema } from "./text";

export const SEARCH_FIELDS = [
  "title",
  "source",
  "pdfUrl",
  "tags",
  "notes",
  "key",
] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

export const AdvancedSearchSettingsSchema = z.strictObject({
  query: z.string(),
  matchCase: z.boolean(),
  matchType: z.enum(["all", "any"]),
  searchFields: z.record(z.enum(SEARCH_FIELDS), z.boolean()),
});

const NameSchema = TrimmedSchema;

export const CollectionSchema = z.strictObject({
  id: NonEmptySchema,
  name: NameSchema,
  parentId: NonEmptySchema.optional(),
  description: z.string(),
  pinned: z.boolean(),
  keepOffline: z.boolean(),
}).describe(
  "A collection: its name, its parent (for a subcollection), a description, whether it is pinned to the front of the collections, and whether its items stay in the bucket after a send to Zotero (Keep offline).",
);

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
]).describe(
  "A filing change that concerns a collection, for its recent activity: its creation, items filed into it, items in it tagged, or Keep offline switched.",
);

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
export const AVAILABILITIES = ["cached", "offline"] as const;
export const RuleSchema = z.discriminatedUnion("field", [
  TextRule,
  containsRule("title"),
  containsRule("author"),
  isRule("tag"),
  isRule("topic"),
  isRule("collection"),
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
]).describe(
  "One condition of a saved search (a smart collection). `text` is the filter bar's search; the others test one field of the item. A `collection` value is a collection id, and the rule holds for its subcollections too. A `source` value is a source domain, as the table's Source column shows it. A `status` value says whether the item's PDF can still be fetched from where it came from.",
);

export const RULE_FIELDS = RuleSchema.options.map(
  (option) => option.shape.field.value,
);

export const SavedSearchSchema = z.strictObject({
  id: NonEmptySchema,
  name: NameSchema,
  match: z.enum(["all", "any"]),
  rules: z.array(RuleSchema).min(1),
}).describe(
  "A saved search: its rules, all of which or any of which an item must meet.",
);

export const ZoomLevelSchema = z
  .union([z.number().positive(), z.enum(["automatic", "fit-page", "fit-width"])])
  .describe(
    "The reader's zoom: a scale factor, or one of EmbedPDF's zoom modes, which fit the page or its width to the window.",
  );

export const ReadingSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unread") }),
  z.strictObject({
    status: z.literal("viewed"),
    page: z.int().min(1),
    pages: z.int().min(1),
    zoom: ZoomLevelSchema.optional().describe(
      "The zoom the reader last showed. Records made before the reader reported its zoom have none; the reader then opens at its default zoom.",
    ),
    viewedAt: z.iso.datetime({ offset: true }),
  }),
]).describe(
  "How far an item has been read: never opened, or the page and zoom the reader last showed, with the document's page count.",
);

export const ReadingRequestSchema = z
  .strictObject({
    page: z.int().min(1),
    pages: z.int().min(1),
    zoom: ZoomLevelSchema,
    edition: ProvenanceSchema,
  })
  .refine(
    (reading) => reading.page <= reading.pages,
    "page lies beyond the page count",
  );

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
]).describe(
  "Whether a URL still serves the captured PDF: never checked; the same bytes (accessible); other bytes (changed); or no PDF at all (dead), with the HTTP status or network error.",
);

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

export const MirrorSchema = z.strictObject({
  url: HttpUrlSchema,
  check: SourceCheckSchema,
}).describe(
  "Another URL that serves the same PDF; Rebuild tries mirrors after the PDF URL.",
);

export const MirrorRequestSchema = z.strictObject({ url: HttpUrlSchema });

export const SourceLineageSchema = z.strictObject({
  originalKey: NonEmptySchema,
  originalProvenance: ProvenanceSchema,
  preferredKey: NonEmptySchema,
  discoveredSourceUrl: HttpUrlSchema,
  promotedAt: z.iso.datetime({ offset: true }),
});

export const ItemNoteSchema = z.strictObject({
  id: NonEmptySchema,
  note: TrimmedSchema,
  dateAdded: z.iso.datetime({ offset: true }),
  dateModified: z.iso.datetime({ offset: true }),
});

const ArtifactSchema = z.strictObject({
  name: NonEmptySchema,
  path: NonEmptySchema,
  sizeBytes: z.number().int().nonnegative(),
});

export const ExtractionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({
    status: z.literal("extracted"),
    sourceKind: z.enum(["arxiv_latex", "ocr", "document_structure"]),
    authoritative: z.boolean(),
    markdown: ArtifactSchema,
    files: z.array(ArtifactSchema),
  }),
  z.strictObject({
    status: z.literal("unlabelled"),
    reason: NonEmptySchema,
    markdown: ArtifactSchema,
    files: z.array(ArtifactSchema),
  }),
]).describe(
  "An item's extraction, derived from the files beside its PDF and never stored elsewhere: `<key>.md` is the Markdown and marks a complete extraction (the runner writes it last); `<key>.extraction/` holds the further artifacts. No Markdown means no extraction. An artifact's `name` is the Markdown's file name, or its path inside `<key>.extraction/`. `unlabelled` is a Markdown whose `<key>.extraction/metadata.json` is missing or invalid: its source kind is unknown, so the library shows the reason and the user runs the extraction again.",
);

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
]).describe(
  "A step of a send once the Zotero item exists: set its URL and access date (`fields`), attach the bucket's PDF (`pdf`), attach the extraction Markdown when the item has one (`markdown`), and add each of the item's notes as a Zotero child note (`note`). The `notes` step is owed while any note has no `note` step.",
);

export const SendMethodSchema = z.enum([
  ...ImportMethodSchema.options,
  "standalone_attachment",
]).describe(
  "How a send made its Zotero item: by one of the write API's methods, or as a standalone attachment (Send PDF Only), the PDF with no parent item, which owes only the `pdf` step.",
);

export const ZoteroRecordSchema = z.strictObject({
  itemKey: NonEmptySchema,
  sentAt: z.iso.datetime({ offset: true }),
  method: SendMethodSchema,
  steps: z.array(SendStepSchema),
}).describe(
  "The Zotero item a send goes to (for a standalone attachment, the attachment), and the steps done on it so far.",
);

export const ZoteroStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unsent") }),
  z.strictObject({
    status: z.literal("sent"),
    record: ZoteroRecordSchema,
    pending: z.array(z.enum(SEND_STEPS)),
  }),
]).describe(
  "Whether an item is in Zotero. `pending` lists the steps still owed: a send that failed part way, or an extraction made after the send, leaves steps that a later send completes.",
);

export const SendTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("collection"),
    collectionKey: NonEmptySchema,
    collectionName: NonEmptySchema,
  }),
  z.strictObject({ kind: z.literal("library") }),
  z.strictObject({ kind: z.literal("earlier_send") }),
]).describe(
  "Where a send put the item in Zotero: the collection selected in Zotero's pane, with its key and its name as Zotero shows it (`collection`), the library root when the selected row is not a collection (`library`), or nowhere new, because the send finished an earlier send (`earlier_send`).",
);

export const SendResponseSchema = z.strictObject({
  itemKey: NonEmptySchema,
  created: z.boolean(),
  performed: z.array(z.enum(SEND_STEPS)),
  kept: z.boolean(),
  target: SendTargetSchema,
}).describe(
  "The answer to a send: the Zotero item, the steps this send performed, and where the item is in Zotero. `created`: this send made the Zotero item; false when it finished an earlier send, or the write API found the work already in Zotero and the send went to that item. `kept`: the item stays in the bucket because a collection holding it keeps its items offline.",
);

export const SendAndExtractResponseSchema = z.strictObject({
  send: SendResponseSchema,
  extractions: z.array(ExtractionOutcomeSchema),
}).describe(
  "The answer to Send to Zotero and Extract: the send, made before any extraction, and each plugin of the configured chain tried after it, in order, up to the first that extracted the PDF, whose Markdown the send's `performed` then lists. An item with Markdown already tries no plugin, and its send attaches that Markdown. The item leaves the bucket once the chain has ended, as a send's does, unless `send.kept`.",
);

export const TITLE_SOURCES = [
  "manual",
  "resolver",
  "guess",
  "pdf-metadata",
  "capture-hint",
  "filename",
] as const;

export const TitleSourceSchema = z.enum(TITLE_SOURCES).describe(
  "Where an item's title came from: a manual edit, Zotero's resolution of its URL (Retrieve metadata), an inference, the PDF, the capture hint, or the file name.",
);

export const BucketItemSchema = z.strictObject({
  id: NonEmptySchema,
  title: NonEmptySchema,
  titleSource: TitleSourceSchema,
  authors: z.array(NonEmptySchema),
  year: z.int().nullable(),
  abstract: NonEmptySchema.nullable(),
  tags: z.array(NonEmptySchema),
  collections: z.array(NonEmptySchema),
  notes: z.array(ItemNoteSchema),
  reading: ReadingSchema,
  sourceCheck: SourceCheckSchema,
  mirrors: z.array(MirrorSchema),
  sourceLineage: SourceLineageSchema.optional(),
  dateAdded: z.iso.datetime({ offset: true }),
  dateModified: z.iso.datetime({ offset: true }),
  provenance: ProvenanceSchema,
  file: z.strictObject({
    path: NonEmptySchema,
    sizeBytes: z.number().int().nonnegative(),
  }),
  extraction: ExtractionSchema,
  zotero: ZoteroStatusSchema,
}).describe(
  "The library item: title, url, tags, collections, notes and dates have the same meaning as in a reference-manager item; provenance, file and extraction are the bucket's own. `year` comes from Retrieve metadata and is null when it gave none.",
);

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

export const ArxivMatchSchema = z.strictObject({
  id: NonEmptySchema,
  version: NonEmptySchema,
  title: NonEmptySchema,
  authors: z.array(NonEmptySchema).min(1),
  abstract: NonEmptySchema.nullable(),
  year: z.int().nullable(),
  score: z.number().min(0).max(1),
  absUrl: z.url(),
  pdfUrl: z.url(),
  reasons: z.array(NonEmptySchema).min(1),
}).describe(
  "A deterministic arXiv API candidate for an item's structured metadata. The score is in [0, 1] and ranks the candidates; the user decides which candidate, if any, is the paper.",
);

export const ArxivSearchResponseSchema = z.strictObject({
  matches: z.array(ArxivMatchSchema),
});

export const ArxivPromotionResponseSchema = z.strictObject({
  key: NonEmptySchema,
  originalKey: NonEmptySchema,
  existing: z.boolean(),
  missing: z.boolean(),
  sourceLineage: SourceLineageSchema,
}).describe(
  "The result of replacing one paper's PDF with a confident arXiv candidate.",
);

export const MissingItemSchema = z.strictObject({
  key: NonEmptySchema,
  title: NonEmptySchema,
  authors: z.array(NonEmptySchema),
  provenance: ProvenanceSchema,
  mirrors: z.array(HttpUrlSchema),
}).describe(
  "An item the index export holds whose PDF the store has lost: what Rebuild needs to fetch it again and what the library shows of it meanwhile.",
);

export const MIN_PAGE_SECONDS = 5;
export const READER_IDLE_MINUTES = 10;

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
}).describe(
  "A reading session, as the reader reports it while a PDF is open: when it opened, the last moment it was read (idle time excluded), and each page read, with the seconds spent on it in stretches of at least MIN_PAGE_SECONDS; a page scrolled past in less is not read. After READER_IDLE_MINUTES without input, the reader stops counting time as reading.",
);

export const ReadingSessionSchema = ReadingSessionReportSchema.extend({
  item: z.strictObject({
    title: NonEmptySchema,
    authors: z.array(NonEmptySchema),
    year: z.int().nullable(),
    abstract: NonEmptySchema.nullable(),
    pdfUrl: z.url(),
  }),
}).describe(
  "A stored reading session. It carries the item as it was when read, so the timeline outlives the item; `pdfUrl` is where the PDF came from.",
);

export const THEMES = ["system", "light", "dark"] as const;
export const ThemeSchema = z.enum(THEMES).describe(
  "The colours of the library and the reader: the system's light or dark setting, or always one of the two.",
);

export const PreferencesSchema = z.strictObject({
  outlineOnOpen: z.boolean(),
  theme: ThemeSchema,
  readerNightMode: z.boolean(),
}).describe(
  "How the app behaves: whether the reader opens a PDF with its outline showing, the theme, and whether the reader draws the PDF's pages in dark page colours while the theme is dark.",
);

export const LibraryPayloadSchema = z.strictObject({
  items: z.array(BucketItemSchema),
  missing: z.array(MissingItemSchema),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  activity: z.array(ActivitySchema),
  preferences: PreferencesSchema,
  unreadable: z.array(
    z.strictObject({ file: NonEmptySchema, message: NonEmptySchema }),
  ),
}).describe(
  "The library. `unreadable` names the files `<key>.pdf` in the root that the store cannot read (torn, foreign, without the bucket's provenance); the library lists every other item.",
);

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
]).describe(
  "What Rebuild did for one item: its PDF was there; it was downloaded again from the PDF URL or a mirror and matched the recorded original; every URL was tried and none served it; or the rebuild failed in the bucket itself (the store could not write the PDF). A restored PDF's metadata: the title and authors Retrieve metadata gave, recorded again; none to record, since the item's title was read from the PDF; or a recording that failed, which leaves the PDF restored with the title it carries.",
);

export const ImportUrlRequestSchema = z.strictObject({
  url: HttpUrlSchema,
  open_reader: z.boolean(),
}).describe(
  "Import URL: a PDF URL, or a page whose Highwire `citation_pdf_url` names the PDF. With `open_reader`, the stored item's reader opens in the desktop window, as after a capture.",
);
export const ImportUrlResponseSchema = z.strictObject({
  key: NonEmptySchema,
  existing: z.boolean(),
}).describe(
  "The answer to Import URL. A new PDF runs Retrieve metadata in the background, as a captured one does.",
);

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
}).describe(
  "Add Folder: one outcome per file directly inside the folder whose name ends in `.pdf`, in name order: stored under a new key, already held, not a PDF (no `%PDF-` header), or failed in the store. One file's failure never discards the others'.",
);

export const API_ERROR_KINDS = [
  "invalid_request",
  "unknown_item",
  "unknown_collection",
  "unknown_note",
  "unknown_mirror",
  "unknown_saved_search",
  "unknown_plugin",
  "unknown_extension_build",
  "already_sent",
  "pdf_only_refused",
  "provenance_mismatch",
  "no_pdf_at_url",
  "not_a_folder",
  "folder_check_failed",
  "metadata_guess_failed",
  "zotero_failed",
  "zotero_unavailable",
  "storage_check_failed",
  "store_failed",
  "unreadable_pdf",
  "not_a_pdf",
  "stale_pdf",
  "plugin_contract_broken",
  "internal",
  "cross_origin_request",
  "unsupported_media_type",
  "ai_unavailable",
  "placeholder_title",
  "arxiv_unavailable",
] as const;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    kind: z.enum(API_ERROR_KINDS),
    message: NonEmptySchema,
  }),
}).describe(
  "An API error. `unknown_extension_build`: the bucket was given no signed Firefox build to offer. `pdf_only_refused`: Send PDF Only for an item with notes or Markdown, which a standalone attachment cannot hold. `zotero_unavailable`: Zotero's health check failed before a Zotero action, because Zotero is not running or has no local write API. `store_failed`: a store write or its pikepdf command failed. `unreadable_pdf`: a PDF the store cannot read (torn, encrypted, not a PDF inside). `not_a_pdf`: bytes with no `%PDF-` header in their first 1024 bytes. `stale_pdf`: a reader save whose If-Match names bytes the stored file no longer holds (HTTP 412). `plugin_contract_broken`: a plugin that exited 0 without writing what its contract names. `internal`: a fault in the bucket itself. `ai_unavailable`: the assistant pane's OpenCode server did not start or did not answer. `placeholder_title`: arXiv discovery on a title that names no paper (a page label, None, the file name). `arxiv_unavailable`: the arXiv API refused a discovery request (HTTP 429 or 503) or could not be reached.",
);

export const NoteRequestSchema = z.strictObject({ note: TrimmedSchema });
const BulkKeysSchema = z.array(NonEmptySchema).min(1);
export const BulkTagsRequestSchema = z.strictObject({
  keys: BulkKeysSchema,
  add: z.array(TrimmedSchema),
  remove: z.array(TrimmedSchema),
}).describe(
  "A tag change to every item listed: `remove` is taken away first, then `add` goes after what each item keeps. Either array may be empty.",
);
export const BulkCollectionsRequestSchema = z.strictObject({
  keys: BulkKeysSchema,
  add: z.array(NonEmptySchema),
  remove: z.array(NonEmptySchema),
}).describe(
  "A collection change to every item listed: `remove` is taken away first, then `add` goes after what each item keeps. Either array may be empty.",
);
export const NewCollectionRequestSchema = z.strictObject({
  name: NameSchema,
  parentId: NonEmptySchema.optional(),
});
function changingSomething<T extends z.ZodObject>(update: T) {
  return update
    .refine(
      (fields) => Object.keys(fields).length > 0,
      "the update changes nothing",
    )
    .meta({ minProperties: 1 });
}
export const CollectionUpdateRequestSchema = changingSomething(
  z
    .strictObject({
      name: NameSchema,
      description: z.string(),
      pinned: z.boolean(),
      keepOffline: z.boolean(),
    })
    .partial(),
).describe(
  "Any of a collection's own fields; the others stay as they are. At least one field: the refinement checks it in TypeScript, and `minProperties` checks it in the server.",
);
export const PreferencesUpdateRequestSchema = changingSomething(
  PreferencesSchema.partial(),
).describe(
  "Any of the preferences; the others stay as they are. At least one field: the refinement checks it in TypeScript, and `minProperties` checks it in the server.",
);
export const NewSavedSearchRequestSchema = SavedSearchSchema.omit({ id: true });
export const SavedSearchUpdateRequestSchema = SavedSearchSchema.omit({
  id: true,
});

export const SettingsSchema = z.strictObject({
  root: NonEmptySchema,
  organizationFile: NonEmptySchema,
});

export function collectionSubtree(
  collections: Collection[],
  id: string,
): Set<string> {
  const subtree = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const collection of collections) {
      const below =
        collection.parentId !== undefined && subtree.has(collection.parentId);
      if (below && !subtree.has(collection.id)) {
        subtree.add(collection.id);
        grew = true;
      }
    }
  }
  return subtree;
}

export const TOPIC_PREFIX = "topic:";

export type Provenance = z.infer<typeof ProvenanceSchema>;
export type RecordedZoom = z.infer<typeof ZoomLevelSchema>;
export type AdvancedSearchSettings = z.infer<
  typeof AdvancedSearchSettingsSchema
>;
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
export type ImportMethod = z.infer<typeof ImportMethodSchema>;
export type ZoteroRecord = z.infer<typeof ZoteroRecordSchema>;
export type ZoteroStatus = z.infer<typeof ZoteroStatusSchema>;
export type SendResponse = z.infer<typeof SendResponseSchema>;
export type SendTarget = z.infer<typeof SendTargetSchema>;
export type SendAndExtractResponse = z.infer<
  typeof SendAndExtractResponseSchema
>;
export type SendMethod = z.infer<typeof SendMethodSchema>;
export type TitleSource = z.infer<typeof TitleSourceSchema>;
export type Reading = z.infer<typeof ReadingSchema>;
export type SourceCheck = z.infer<typeof SourceCheckSchema>;
export type Mirror = z.infer<typeof MirrorSchema>;
export type MissingItem = z.infer<typeof MissingItemSchema>;
export type RebuildOutcome = z.infer<typeof RebuildOutcomeSchema>;
export type ImportUrlRequest = z.infer<typeof ImportUrlRequestSchema>;
export type ImportUrlResponse = z.infer<typeof ImportUrlResponseSchema>;
export type FolderImportResponse = z.infer<typeof FolderImportResponseSchema>;
export type RetrieveMetadataOutcome = z.infer<
  typeof RetrieveMetadataOutcomeSchema
>;
export type RetrieveMetadataResponse = z.infer<
  typeof RetrieveMetadataResponseSchema
>;
export type ManualMetadataRequest = z.infer<typeof ManualMetadataRequestSchema>;
export type GuessMetadataResponse = z.infer<typeof GuessMetadataResponseSchema>;
export type ArxivSearchResponse = z.infer<typeof ArxivSearchResponseSchema>;
export type ArxivMatch = z.infer<typeof ArxivMatchSchema>;
export type ArxivPromotionResponse = z.infer<
  typeof ArxivPromotionResponseSchema
>;

export const LIBRARY_VIEW_KEY = "pdf-bucket.library-view";
export const LibraryViewKeySchema = z.literal(LIBRARY_VIEW_KEY).describe(
  "The session-storage key under which the library page keeps its current view (the address's hash, for example `#/unfiled`); the reader's Library button returns to that view.",
);

export const WINDOW_TABS_KEY = "pdf-bucket.window-tabs";
export const WindowTabsKeySchema = z.literal(WINDOW_TABS_KEY).describe(
  "The session-storage key under which the library window keeps its reader tabs while the page unloads, so a reload of the window gives them back.",
);

export const WindowTabsSchema = z
  .strictObject({
    tabs: z.array(
      z.strictObject({
        key: z.string().min(1),
        title: z.string(),
        position: z
          .strictObject({
            pageNumber: z.int().min(1),
            x: z.number(),
            y: z.number(),
            zoom: ZoomLevelSchema,
          })
          .nullable()
          .describe(
            "Where the PDF was: its page, the page coordinates of the viewport's top-left corner, and the zoom; null for a PDF still loading or that failed to open, which reopens at its reading record.",
          ),
      }),
    ),
    shown: z
      .string()
      .min(1)
      .nullable()
      .describe("The key of the tab shown, or null when the Library showed."),
    fromReaderReload: z
      .boolean()
      .describe(
        "True when the reader page at a tab's address was reloaded and handed the window back to the library page.",
      ),
  })
  .describe(
    "The library window's reader tabs in tab order, kept in session storage when the page unloads.",
  );
export type WindowTabs = z.infer<typeof WindowTabsSchema>;
export type SavedTab = WindowTabs["tabs"][number];
