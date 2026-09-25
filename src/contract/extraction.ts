// The extraction API contract and the plugin manifests: the plugin listing, a run's outcome,
// and the two manifest files the server validates against these schemas alone. Shared by the
// server and the library UI, so it imports nothing server-side.
import { z } from "zod";
import { NonEmptySchema, Sha256Schema } from "./text";

export const PdfLimitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("max_pages"), value: z.int().positive() }),
  z.strictObject({ kind: z.literal("max_bytes"), value: z.int().positive() }),
]);

// What an extraction plugin accepts: a PDF within every listed limit; no limits means any PDF.
export const PdfInputSchema = z.strictObject({
  kind: z.literal("pdf"),
  id: NonEmptySchema,
  label: NonEmptySchema,
  limits: z.array(PdfLimitSchema),
});

// What a resolver plugin accepts: an identifier its pattern (an ECMAScript regular expression,
// matched without regard to case) matches.
export const IdentifierInputSchema = z.strictObject({
  kind: z.literal("identifier"),
  id: NonEmptySchema,
  label: NonEmptySchema,
  example: NonEmptySchema,
  pattern: NonEmptySchema,
});

const pluginCommand = <I extends z.ZodType>(input: I) =>
  z.strictObject({
    id: NonEmptySchema,
    name: NonEmptySchema,
    command: z.array(z.string()).min(1),
    accepted_inputs: z.array(input).min(1),
  });

// `plugins/manifests/extractions.json`: `$pdf` and `$output` in a command are replaced by the
// stored PDF and an empty output directory; on exit 0 the plugin has written
// `$output/extraction.md` and, when it has more, files under `$output/artifacts/`.
export const ExtractionManifestSchema = z.strictObject({
  plugins: z.array(pluginCommand(PdfInputSchema)),
});

// `plugins/manifests/resolvers.json`: the identifier goes to the command's stdin and one BibTeX
// entry comes back on its stdout; the command runs in the manifest's directory.
export const ResolverManifestSchema = z.strictObject({
  plugins: z.array(pluginCommand(IdentifierInputSchema)),
});

export const ExtractionPluginsResponseSchema = z.strictObject({
  plugins: z.array(
    z.strictObject({
      id: NonEmptySchema,
      name: NonEmptySchema,
      accepted_inputs: z.array(PdfInputSchema),
    }),
  ),
});

const ArtifactFileSchema = z.strictObject({
  path: NonEmptySchema,
  sha256: Sha256Schema,
  size: z.int().nonnegative(),
});

// A run's outcome: the placed Markdown and artifacts (the previous extraction went to the
// trash); the plugin's non-zero exit; the PDF outside the plugin's limits (it did not run); or
// the plugin killed after the configured time limit. Only a success changes the files.
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
  z.strictObject({
    status: z.literal("timed_out"),
    key: NonEmptySchema,
    plugin_id: NonEmptySchema,
    seconds: z.int().positive(),
  }),
]);

export type PdfLimit = z.infer<typeof PdfLimitSchema>;
export type ExtractionPlugin = z.infer<typeof ExtractionPluginsResponseSchema>["plugins"][number];
export type ExtractionPluginsResponse = z.infer<typeof ExtractionPluginsResponseSchema>;
export type ExtractionOutcome = z.infer<typeof ExtractionOutcomeSchema>;
export type ExtractionManifest = z.infer<typeof ExtractionManifestSchema>;
export type ResolverManifest = z.infer<typeof ResolverManifestSchema>;
