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

// The outcome of "Retrieve metadata": the resolver that answered and the title it gave; no
// identifier the resolvers know; the resolver that failed or ran past its time limit; or a
// retrieval that failed in the bucket itself (a BibTeX entry that does not parse, a store
// failure). Every outcome but `resolved` leaves the item's title as it was.
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
  z.strictObject({ status: z.literal("error"), message: NonEmptySchema }),
]);

// `metadata` is the outcome of the resolvers run on a newly stored PDF, null when the capture
// found the PDF already stored. A PDF is stored whatever that outcome is.
export const CaptureResponseSchema = z.strictObject({
  key: NonEmptySchema,
  existing: z.boolean(),
  stored_sha256: Sha256Schema,
  reader_url: z.url(),
  pdf_url: z.url(),
  provenance: ProvenanceSchema,
  metadata: RetrieveMetadataOutcomeSchema.nullable(),
});

export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

// `GET /api/events` sends one `open-reader` event per capture, new or existing: the library
// opens the item's reader in a tab under the item's title, and the desktop window comes to the
// front.
export const OpenReaderSchema = z.strictObject({ reader_url: z.url(), title: NonEmptySchema });

export const SERVICE_NAME = "pdf-bucket";

// `GET /status`: the capture extension and the library read it to tell whether the bucket is
// up and able to store captures.
export const ServerStatusSchema = z.strictObject({
  backend_url: z.url(),
  root: NonEmptySchema,
  service: z.strictObject({ name: z.literal(SERVICE_NAME), version: NonEmptySchema }),
  storage: z.strictObject({ root_exists: z.boolean(), root_writable: z.boolean() }),
  capabilities: z.strictObject({ capture: z.boolean() }),
  ready: z.boolean(),
});

export type ServerStatus = z.infer<typeof ServerStatusSchema>;
