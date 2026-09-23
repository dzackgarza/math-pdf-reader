// The capture contract a capture client (the browser extension) shares with the server.
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
