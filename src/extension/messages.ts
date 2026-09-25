// Messages from content scripts and the capture page to the background, which owns the PDF's
// bytes, the post to the bucket, the link-origin record and the exemptions, and the replies it
// sends back. The sender's tab and frame come from the runtime, never from the message.
import { z } from "zod";
import { type CaptureResponse, CaptureResponseSchema } from "../contract/capture";

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

// Where a capture failed: getting the PDF's bytes, the bucket refusing them or answering
// outside its contract, or the extension itself (a background error, no reply in time).
export const FailedSchema = z.strictObject({
  kind: z.literal("failed"),
  error: z.strictObject({
    stage: z.enum(["fetch-pdf", "post-bucket", "extension"]),
    detail: z.string(),
  }),
});

export type Failed = z.infer<typeof FailedSchema>;

export function failed(stage: Failed["error"]["stage"], detail: string): Failed {
  return { kind: "failed", error: { stage, detail } };
}

export const CaptureOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stored"), response: CaptureResponseSchema }),
  FailedSchema,
]);

export type CaptureOutcome = z.infer<typeof CaptureOutcomeSchema>;

// The reply to every message but `capture`.
export const DoneReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("done") }),
  FailedSchema,
]);

export type DoneReply = z.infer<typeof DoneReplySchema>;

// Why a stored capture has no retrieved metadata, or null when nothing went wrong.
export function metadataFailure(response: CaptureResponse): string | null {
  const { metadata } = response;
  switch (metadata?.status) {
    case "failed":
      return `${metadata.pluginId} failed for ${metadata.identifier}: ${metadata.message}`;
    case "error":
      return metadata.message;
    default:
      return null;
  }
}
