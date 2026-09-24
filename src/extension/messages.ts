// Messages from content scripts and the capture page to the background, which owns the
// fetch (with the browser's cookies), the post to the bucket, the link-origin record and
// the exemptions. The sender's tab comes from the runtime, never from the message.
import { z } from "zod";
import { CaptureResponseSchema } from "../contract/capture";

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

export const LinkOriginSchema = z.strictObject({
  source_url: HttpUrlSchema,
  link_text: z.string(),
  page_title: z.string(),
  recorded_at: z.number(),
});

export type LinkOrigin = z.infer<typeof LinkOriginSchema>;

export const RuntimeMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("remember-link"),
    href: HttpUrlSchema,
    origin: LinkOriginSchema,
  }),
  z.strictObject({ type: z.literal("capture"), pdf_url: HttpUrlSchema }),
  z.strictObject({ type: z.literal("exempt"), pdf_url: HttpUrlSchema }),
  // The capture page's tab was opened for the PDF alone and the capture succeeded.
  z.strictObject({ type: z.literal("close-tab") }),
]);

export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;

export const CaptureOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stored"), response: CaptureResponseSchema }),
  z.strictObject({
    kind: z.literal("failed"),
    error: z.strictObject({ stage: z.enum(["fetch-pdf", "post-bucket"]), detail: z.string() }),
  }),
]);

export type CaptureOutcome = z.infer<typeof CaptureOutcomeSchema>;
