// The extraction API contract: the plugin listing and a run's outcome. Shared by the server
// and the library UI, so it imports nothing server-side.
import { z } from "zod";
import { NonEmptySchema, Sha256Schema } from "./text";

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
      id: NonEmptySchema,
      name: NonEmptySchema,
      accepted_inputs: z.array(AcceptedInputSchema),
    }),
  ),
});

const ArtifactFileSchema = z.strictObject({
  path: NonEmptySchema,
  sha256: Sha256Schema,
  size: z.int().nonnegative(),
});

export const ExtractionOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    key: NonEmptySchema,
    plugin_id: NonEmptySchema,
    markdown: ArtifactFileSchema,
    artifacts: z.array(ArtifactFileSchema),
  }),
  z.strictObject({
    status: z.literal("failed"),
    key: NonEmptySchema,
    plugin_id: NonEmptySchema,
    exit_code: z.int(),
    stderr: z.string(),
  }),
  z.strictObject({
    status: z.literal("rejected"),
    key: NonEmptySchema,
    plugin_id: NonEmptySchema,
    violations: z.array(z.strictObject({ limit: PdfLimitSchema, observed: z.int() })),
  }),
]);

export type PdfLimit = z.infer<typeof PdfLimitSchema>;
export type ExtractionPlugin = z.infer<typeof ExtractionPluginsResponseSchema>["plugins"][number];
export type ExtractionPluginsResponse = z.infer<typeof ExtractionPluginsResponseSchema>;
export type ExtractionOutcome = z.infer<typeof ExtractionOutcomeSchema>;

// A plugin manifest (`plugins/manifests/*.json`): each plugin's command and the inputs it
// accepts. Extraction plugins and identifier resolvers share this shape.
export const PluginManifestSchema = z.strictObject({
  plugins: z.array(
    z.strictObject({
      id: NonEmptySchema,
      name: NonEmptySchema,
      command: z.array(z.string()).min(1),
      accepted_inputs: z.array(AcceptedInputSchema),
    }),
  ),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
