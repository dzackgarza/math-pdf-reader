// The contract a capture client (the browser extension) shares with the server: the capture
// response and the status report.
// The extension bundles this module, so it imports nothing server-side.
import { z } from "zod";
import { NonEmptySchema, Sha256Schema } from "./text";

// Where a stored PDF came from, embedded in the file. `source_url` is the page that linked to
// the PDF, null when no linking page is known (the PDF then carries no `/PDFBucketSourceURL`).
export const ProvenanceSchema = z.strictObject({
  pdf_url: z.url(),
  source_url: z.url().nullable(),
  captured_at: z.iso.datetime({ offset: true }),
  original_sha256: Sha256Schema,
  title_hint: NonEmptySchema,
});

// How the Zotero local write API identified a source: Zotero's web translators, the page's
// citation metadata, an identifier found in the source, BibTeX the source publishes, a search
// of a metadata service, or recognition of the PDF.
export const ImportMethodSchema = z.enum([
  "web_translator",
  "page_metadata",
  "identifier",
  "published_bibtex",
  "external_service",
  "pdf_recognition",
]);

// The outcome of "Retrieve metadata", which asks the Zotero local write API to resolve the
// item's URL and saves nothing in Zotero: the method that identified the source and the title
// it gave; each method's attempt when none identified it; Zotero not running or without the
// write API, found by its health check before the request; or a retrieval that failed (a Zotero
// refusal, an answer the bucket cannot use, a store failure). Every outcome but `resolved`
// leaves the item's title as it was.
export const RetrieveMetadataOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("resolved"),
    method: ImportMethodSchema,
    title: NonEmptySchema,
  }),
  z.strictObject({
    status: z.literal("unidentified"),
    attempts: z.array(
      z.strictObject({
        method: ImportMethodSchema,
        outcome: z.enum(["identified", "no_match", "ambiguous", "failed"]),
        message: z.string(),
      }),
    ),
  }),
  z.strictObject({ status: z.literal("zotero_unavailable"), message: NonEmptySchema }),
  z.strictObject({ status: z.literal("error"), message: NonEmptySchema }),
]);

// The answer to a capture, sent as soon as the PDF is stored. A newly stored PDF then runs
// "Retrieve metadata" in the background; its outcome is a `metadata` event.
export const CaptureResponseSchema = z.strictObject({
  key: NonEmptySchema,
  existing: z.boolean(),
  stored_sha256: Sha256Schema,
  reader_url: z.url(),
  pdf_url: z.url(),
  provenance: ProvenanceSchema,
});

export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

// `POST /capture-download`, from the extension in Chrome, which cannot read a navigation's
// response body: the navigation is saved as a download, and the bucket reads the saved file at
// `path`. `filename` is the name the PDF was offered under (Chrome renames a download whose
// name is taken); `source_url` is absent when no linking page is known.
export const CaptureDownloadRequestSchema = z.strictObject({
  path: NonEmptySchema,
  filename: NonEmptySchema,
  pdf_url: z.url(),
  source_url: z.url().optional(),
  title_hint: NonEmptySchema,
});

export type CaptureDownloadRequest = z.infer<typeof CaptureDownloadRequestSchema>;

// `GET /api/events` sends one `open-reader` event per capture, new or existing: the library
// opens the item's reader in a tab under the item's title, and the desktop window comes to the
// front.
export const OpenReaderSchema = z.strictObject({ reader_url: z.url(), title: NonEmptySchema });

// `GET /api/events` sends one `metadata` event per "Retrieve metadata" a newly stored PDF runs
// in the background (capture, Import URL, Add Folder), with the item's key and the outcome.
export const MetadataEventSchema = z.strictObject({
  key: NonEmptySchema,
  outcome: RetrieveMetadataOutcomeSchema,
});

// Whether Zotero can take a request, from the local write API's health check (`GET /version`):
// not checked yet; ready, with the write API's version; or unavailable, with what to do about
// it. The server checks at a fixed interval and before every Zotero action. `GET /api/events`
// sends a `zotero` event with each new state, and the current one first.
export const ZoteroHealthSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("checking") }),
  z.strictObject({ status: z.literal("ready"), version: NonEmptySchema }),
  z.strictObject({ status: z.literal("unavailable"), message: NonEmptySchema }),
]);

export const SERVICE_NAME = "pdf-bucket";

// The index export the running server rewrites after every change (`file`): not yet written
// since the server started; written, with how many items; refused, because it lists items whose
// PDFs the store lost and nobody removed (Rebuild restores them; forgetting one drops it); or
// failed for another reason. `GET /api/events` sends an `index-export` event with each new state,
// and the current one first.
export const IndexExportStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending"), file: NonEmptySchema }),
  z.strictObject({
    status: z.literal("written"),
    file: NonEmptySchema,
    written_at: z.iso.datetime({ offset: true }),
    items: z.int().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("refused"),
    file: NonEmptySchema,
    missing: z.array(NonEmptySchema).min(1),
  }),
  z.strictObject({ status: z.literal("failed"), file: NonEmptySchema, message: NonEmptySchema }),
]);

// `GET /status`: the capture extension and the library read it to tell whether the bucket is
// up and able to store captures, and whether its index export is current.
export const ServerStatusSchema = z.strictObject({
  backend_url: z.url(),
  root: NonEmptySchema,
  service: z.strictObject({ name: z.literal(SERVICE_NAME), version: NonEmptySchema }),
  storage: z.strictObject({ root_exists: z.boolean(), root_writable: z.boolean() }),
  capabilities: z.strictObject({ capture: z.boolean() }),
  ready: z.boolean(),
  index_export: IndexExportStateSchema,
});

export type IndexExportState = z.infer<typeof IndexExportStateSchema>;
export type MetadataEvent = z.infer<typeof MetadataEventSchema>;
export type ZoteroHealth = z.infer<typeof ZoteroHealthSchema>;
export type ServerStatus = z.infer<typeof ServerStatusSchema>;
