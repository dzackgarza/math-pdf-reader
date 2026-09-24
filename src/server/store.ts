// Bridge to the Python store: provenance embedding and the folder layout live there.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { STORE_COMMAND } from "./config";
import { ProvenanceSchema } from "./contract";
import { type TitleSource, TitleSourceSchema } from "./libraryContract";

const StoredItemSchema = z.strictObject({
  key: z.string().min(1),
  provenance: ProvenanceSchema,
  title: z.strictObject({ text: z.string().min(1), source: TitleSourceSchema }),
  authors: z.array(z.string().min(1)),
});

const CaptureResultSchema = z.strictObject({
  item: StoredItemSchema,
  stored_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  existing: z.boolean(),
});

export type StoredItem = z.infer<typeof StoredItemSchema>;
export type CaptureResult = z.infer<typeof CaptureResultSchema>;

export type CaptureUpload = {
  pdf: File;
  pdf_url: string;
  source_url: string;
  title_hint: string;
};

export class StoreCommandError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`store command exited with ${exitCode}: ${stderr}`);
  }
}

export async function runStore(args: string[], stdin: Blob | "ignore"): Promise<string> {
  // Bun.spawn without `env` passes the environment the process started with, not process.env
  // as it stands now; the store (and send2trash in it) must see the current one.
  const proc = Bun.spawn([...STORE_COMMAND, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new StoreCommandError(exitCode, stderr);
  }
  return stdout;
}

// The stored PDF for a key, or null when the key names no stored PDF.
export function storedPdfPath(root: string, key: string): string | null {
  if (key !== basename(key) || key === "" || key === "." || key === "..") {
    return null;
  }
  const path = join(root, `${key}.pdf`);
  return existsSync(path) ? path : null;
}

export async function captureBytes(root: string, upload: CaptureUpload): Promise<CaptureResult> {
  const args = [
    "capture",
    "--",
    root,
    "/dev/stdin",
    upload.pdf.name,
    upload.pdf_url,
    upload.source_url,
    upload.title_hint,
  ];
  return CaptureResultSchema.parse(JSON.parse(await runStore(args, upload.pdf)));
}

// The stored items for these keys, read from the PDFs in one store process. `--` ends the
// options, so a key that starts with a dash stays a key.
export async function listItems(root: string, keys: string[]): Promise<StoredItem[]> {
  const stdout = await runStore(["list", root, "--", ...keys], "ignore");
  return z.array(StoredItemSchema).parse(JSON.parse(stdout));
}

export const ResolutionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("resolved"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    identifier: z.string().min(1),
    bibtex: z.string().startsWith("@"),
  }),
  z.strictObject({
    status: z.literal("unidentified"),
    key: z.string().min(1),
    candidates: z.array(z.string()),
  }),
  z.strictObject({
    status: z.literal("failed"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    identifier: z.string().min(1),
    exit_code: z.int(),
    stderr: z.string(),
  }),
]);

export type Resolution = z.infer<typeof ResolutionSchema>;

// Finds an identifier for the item and resolves it to BibTeX with a plugin in the manifest.
export async function resolveItem(
  root: string,
  key: string,
  manifest: string,
): Promise<Resolution> {
  const stdout = await runStore(["resolve", "--", root, key, manifest], "ignore");
  return ResolutionSchema.parse(JSON.parse(stdout));
}

// Records TEXT, from SOURCE, as the item's title and AUTHORS, in order, inside its stored PDF.
export async function recordMetadata(
  root: string,
  key: string,
  text: string,
  source: TitleSource,
  authors: string[],
): Promise<StoredItem> {
  const options = authors.flatMap((author) => ["--author", author]);
  const stdout = await runStore(["metadata", ...options, "--", root, key, text, source], "ignore");
  return StoredItemSchema.parse(JSON.parse(stdout));
}

const ReplaceOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("replaced"), item: StoredItemSchema }),
  z.strictObject({ status: z.literal("provenance_mismatch"), key: z.string().min(1) }),
]);

export type ReplaceOutcome = z.infer<typeof ReplaceOutcomeSchema>;

// Replaces the stored PDF with BYTES, the reader's save with its annotations; the store keeps
// the file unless the bytes carry the provenance embedded in it.
export async function replacePdf(
  root: string,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ReplaceOutcome> {
  const stdout = await runStore(["replace", "--", root, key, "/dev/stdin"], new Blob([bytes]));
  return ReplaceOutcomeSchema.parse(JSON.parse(stdout));
}

// Moves the stored PDF and its extraction to the desktop trash.
export async function removeStored(root: string, key: string): Promise<void> {
  const stdout = await runStore(["remove", "--", root, key], "ignore");
  z.strictObject({ key: z.literal(key), trashed: z.array(z.string()).min(1) }).parse(
    JSON.parse(stdout),
  );
}

// Store bytes re-downloaded for a missing PDF under its key with the provenance recorded at
// capture. The store refuses bytes that do not hash to the recorded original.
export async function restorePdf(
  root: string,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  provenance: StoredItem["provenance"],
): Promise<CaptureResult> {
  const args = [
    "restore",
    "--",
    root,
    "/dev/stdin",
    key,
    provenance.pdf_url,
    provenance.source_url,
    provenance.captured_at,
    provenance.original_sha256,
    provenance.title_hint,
  ];
  return CaptureResultSchema.parse(JSON.parse(await runStore(args, new Blob([bytes]))));
}
