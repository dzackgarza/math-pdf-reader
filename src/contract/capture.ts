// The contract a capture client (the browser extension) shares with the server: the capture
// response and the status report.
// The extension bundles this module, so it imports nothing server-side.
import { z } from "zod";
import { NonEmptySchema, Sha256Schema } from "./text";

export const ProvenanceSchema = z.strictObject({
  pdf_url: z.url(),
  source_url: z.url(),
  captured_at: z.iso.datetime({ offset: true }),
  original_sha256: Sha256Schema,
  title_hint: NonEmptySchema,
});

export const CaptureResponseSchema = z.strictObject({
  key: NonEmptySchema,
  existing: z.boolean(),
  stored_sha256: Sha256Schema,
  reader_url: z.url(),
  pdf_url: z.url(),
  provenance: ProvenanceSchema,
});

export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

// `GET /api/events` sends one `open-reader` event per capture, new or existing: the library
// opens the item's reader in a tab under the item's title, and the desktop window comes to the
// front.
export const OpenReaderSchema = z.strictObject({ reader_url: z.url(), title: NonEmptySchema });

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
export type ServerStatus = z.infer<typeof ServerStatusSchema>;
