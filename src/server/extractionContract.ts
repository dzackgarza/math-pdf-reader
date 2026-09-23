// The extraction API contract: the plugin listing and a run's outcome. Shared by the server
// and the library UI, so it imports nothing server-side.
import { z } from "zod";

export const PdfLimitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("max_pages"), value: z.int().positive() }),
  z.strictObject({ kind: z.literal("max_bytes"), value: z.int().positive() }),
]);

export const AcceptedInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("identifier"),
    id: z.string(),
    label: z.string(),
    example: z.string(),
    pattern: z.string(),
  }),
  z.strictObject({
    kind: z.literal("pdf"),
    id: z.string(),
    label: z.string(),
    limits: z.array(PdfLimitSchema),
  }),
]);

export const ExtractionPluginsResponseSchema = z.strictObject({
  plugins: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      accepted_inputs: z.array(AcceptedInputSchema),
    }),
  ),
});

const ArtifactFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().nonnegative(),
});

export const ExtractionOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    markdown: ArtifactFileSchema,
    artifacts: z.array(ArtifactFileSchema),
  }),
  z.strictObject({
    status: z.literal("failed"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    exit_code: z.int(),
    stderr: z.string(),
  }),
  z.strictObject({
    status: z.literal("rejected"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    violations: z.array(z.strictObject({ limit: PdfLimitSchema, observed: z.int() })),
  }),
]);

export type PdfLimit = z.infer<typeof PdfLimitSchema>;
export type ExtractionPlugin = z.infer<typeof ExtractionPluginsResponseSchema>["plugins"][number];
export type ExtractionPluginsResponse = z.infer<typeof ExtractionPluginsResponseSchema>;
export type ExtractionOutcome = z.infer<typeof ExtractionOutcomeSchema>;
