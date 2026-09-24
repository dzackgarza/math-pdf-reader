// Bridge to the Python store: provenance embedding and the folder layout live there.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type CaptureResult,
  CaptureResultSchema,
  RemovalSchema,
  type ReplaceOutcome,
  ReplaceOutcomeSchema,
  type Resolution,
  ResolutionSchema,
  type StoredItem,
  StoredItemListSchema,
  StoredItemSchema,
} from "../contract/store";
import { STORE_COMMAND } from "./config";

export type { CaptureResult, ReplaceOutcome, Resolution, StoredItem };

import type { TitleSource } from "../contract/library";

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
  return StoredItemListSchema.parse(JSON.parse(stdout));
}

// Finds an identifier for the item and resolves it to BibTeX with a plugin in the manifest.
export async function resolveItem(
  root: string,
  key: string,
  manifest: string,
): Promise<Resolution> {
  const stdout = await runStore(["resolve", "--", root, key, manifest], "ignore");
  return ResolutionSchema.parse(JSON.parse(stdout));
}

// What a resolver gives an item: title, authors in order, year and abstract where known.
export type ResolvedMetadata = {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
};

// Records METADATA, its title from SOURCE, inside the item's stored PDF.
export async function recordMetadata(
  root: string,
  key: string,
  source: TitleSource,
  metadata: ResolvedMetadata,
): Promise<StoredItem> {
  const options = [
    ...metadata.authors.flatMap((author) => ["--author", author]),
    ...(metadata.year === null ? [] : ["--year", String(metadata.year)]),
    ...(metadata.abstract === null ? [] : ["--abstract", metadata.abstract]),
  ];
  const args = ["metadata", ...options, "--", root, key, metadata.title, source];
  return StoredItemSchema.parse(JSON.parse(await runStore(args, "ignore")));
}

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
  RemovalSchema.parse(JSON.parse(stdout));
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
