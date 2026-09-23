// The capture response: what a capture client (the browser extension) receives.
import { z } from "zod";
import { ProvenanceSchema } from "./store";

export const CaptureResponseSchema = z.strictObject({
  key: z.string().min(1),
  existing: z.boolean(),
  stored_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reader_url: z.url(),
  pdf_url: z.url(),
  provenance: ProvenanceSchema,
});

export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;
