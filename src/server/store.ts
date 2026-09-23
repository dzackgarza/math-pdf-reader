// Bridge to the Python store: provenance embedding and the folder layout live there.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { STORE_COMMAND } from "./config";
import { ProvenanceSchema } from "./libraryContract";

const StoredItemSchema = z.strictObject({
  key: z.string().min(1),
  provenance: ProvenanceSchema,
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

async function runStore(args: string[], stdin: Blob | "ignore"): Promise<string> {
  const proc = Bun.spawn([...STORE_COMMAND, ...args], { stdin, stdout: "pipe", stderr: "pipe" });
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
