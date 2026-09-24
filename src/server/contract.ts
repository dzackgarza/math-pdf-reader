// The contract a capture client (the browser extension) shares with the server: the capture
// response and the status report.
// The extension bundles this module, so it imports nothing server-side.
import { z } from "zod";

export const ProvenanceSchema = z.strictObject({
  pdf_url: z.url(),
  source_url: z.url(),
  captured_at: z.iso.datetime({ offset: true }),
  original_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  title_hint: z.string().min(1),
});

export const CaptureResponseSchema = z.strictObject({
  key: z.string().min(1),
  existing: z.boolean(),
  stored_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reader_url: z.url(),
  pdf_url: z.url(),
  provenance: ProvenanceSchema,
});

export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

export const SERVICE_NAME = "pdf-bucket";

// `GET /status`: the capture extension and the library read it to tell whether the bucket is
// up and able to store captures.
export const ServerStatusSchema = z.strictObject({
  backend_url: z.url(),
  root: z.string().min(1),
  service: z.strictObject({ name: z.literal(SERVICE_NAME), version: z.string().min(1) }),
  storage: z.strictObject({ root_exists: z.boolean(), root_writable: z.boolean() }),
  capabilities: z.strictObject({ capture: z.boolean() }),
  ready: z.boolean(),
});

export type ServerStatus = z.infer<typeof ServerStatusSchema>;
