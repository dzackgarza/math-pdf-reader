// What the pikepdf commands (`pdfbucket <command>`) print on stdout. The server owns the store's
// layout and every write; these commands read the PDFs and bytes it names.
import { z } from "zod";
import { ProvenanceSchema } from "./capture";
import { TitleSourceSchema } from "./library";
import { NonEmptySchema } from "./text";

// What a stored PDF says about itself, read from the file alone (`pdfbucket read`).
export const PdfRecordSchema = z.strictObject({
  provenance: ProvenanceSchema,
  title: z.strictObject({ text: NonEmptySchema, source: TitleSourceSchema }),
  authors: z.array(NonEmptySchema),
  year: z.int().nullable(),
  abstract: NonEmptySchema.nullable(),
  pages: z.int().min(1),
});

// `pdfbucket read`: per path, in order, the record or why the file cannot be read.
export const ReadOutcomeListSchema = z.array(
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("read"), record: PdfRecordSchema }),
    z.strictObject({ status: z.literal("unreadable"), message: NonEmptySchema }),
  ]),
);

// `pdfbucket identifiers`: the identifiers the publisher embedded in the PDF.
export const IdentifierListSchema = z.array(NonEmptySchema);

// What a command on one PDF prints, with exit status 3, when it cannot read that PDF.
export const StoreFailureSchema = z.strictObject({
  kind: z.enum(["unreadable_pdf", "missing_provenance", "invalid_metadata"]),
  message: NonEmptySchema,
});

// A stored item as the library and the index export hold it: its key, which the server derives
// from the file name, and what its PDF says about it.
export const StoredItemSchema = PdfRecordSchema.omit({ pages: true }).extend({
  key: NonEmptySchema,
});

export type PdfRecord = z.infer<typeof PdfRecordSchema>;
export type StoredItem = z.infer<typeof StoredItemSchema>;
