// What the Python store (`pdfbucket <command>`) prints on stdout, one JSON document per call.
// The store owns provenance embedding and the folder layout; the server reads these answers.
import { z } from "zod";
import { ProvenanceSchema } from "./capture";
import { TitleSourceSchema } from "./library";
import { NonEmptySchema, Sha256Schema } from "./text";

// A stored PDF as read back from the file alone (`pdfbucket list`, `describe`, `metadata`).
export const StoredItemSchema = z.strictObject({
  key: NonEmptySchema,
  provenance: ProvenanceSchema,
  title: z.strictObject({ text: NonEmptySchema, source: TitleSourceSchema }),
  authors: z.array(NonEmptySchema),
  year: z.int().nullable(),
  abstract: NonEmptySchema.nullable(),
});

export const StoredItemListSchema = z.array(StoredItemSchema);

// `pdfbucket capture` and `restore`.
export const CaptureResultSchema = z.strictObject({
  item: StoredItemSchema,
  stored_sha256: Sha256Schema,
  existing: z.boolean(),
});

// `pdfbucket resolve`: an identifier found and resolved to BibTeX, no identifier a resolver
// accepts, or the resolver that failed.
export const ResolutionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("resolved"),
    key: NonEmptySchema,
    plugin_id: NonEmptySchema,
    identifier: NonEmptySchema,
    bibtex: z.string().startsWith("@"),
  }),
  z.strictObject({
    status: z.literal("unidentified"),
    key: NonEmptySchema,
    candidates: z.array(z.string()),
  }),
  z.strictObject({
    status: z.literal("failed"),
    key: NonEmptySchema,
    plugin_id: NonEmptySchema,
    identifier: NonEmptySchema,
    exit_code: z.int(),
    stderr: z.string(),
  }),
]);

// `pdfbucket replace`: the store keeps the new bytes only when they carry the embedded provenance.
export const ReplaceOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("replaced"), item: StoredItemSchema }),
  z.strictObject({ status: z.literal("provenance_mismatch"), key: NonEmptySchema }),
]);

// `pdfbucket remove`: the paths moved to the desktop trash.
export const RemovalSchema = z.strictObject({
  key: NonEmptySchema,
  trashed: z.array(z.string()).min(1),
});

export type StoredItem = z.infer<typeof StoredItemSchema>;
export type CaptureResult = z.infer<typeof CaptureResultSchema>;
export type Resolution = z.infer<typeof ResolutionSchema>;
export type ReplaceOutcome = z.infer<typeof ReplaceOutcomeSchema>;
