// A bucket below its HTTP API, for tests that set one up or inspect it: the Python store the
// server runs, the documents beside the stored PDFs, and the `pdf-bucket` maintenance commands.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STORE_COMMAND } from "../src/contract/config";
import {
  type IndexExport,
  IndexExportSchema,
  type ItemFiling,
  type Organization,
  OrganizationSchema,
} from "../src/contract/files";
import type { Provenance, TitleSource } from "../src/contract/library";
import {
  type CaptureResult,
  CaptureResultSchema,
  type StoredItem,
  StoredItemListSchema,
  StoredItemSchema,
} from "../src/contract/store";
import { SERVER_BINARY } from "./bucket";

async function runStore(args: string[], stdin: Uint8Array<ArrayBuffer> | null): Promise<string> {
  const store = Bun.spawn([...STORE_COMMAND, ...args], {
    stdin: stdin === null ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(store.stdout).text(),
    new Response(store.stderr).text(),
    store.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`pdfbucket ${args[0]} exited with ${exitCode}: ${stderr}`);
  }
  return stdout;
}

export type Upload = {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  pdfUrl: string;
  sourceUrl: string;
  titleHint: string;
};

export async function captureBytes(root: string, upload: Upload): Promise<CaptureResult> {
  const args = ["capture", "--", root, "/dev/stdin", upload.filename, upload.pdfUrl];
  const stdout = await runStore([...args, upload.sourceUrl, upload.titleHint], upload.bytes);
  return CaptureResultSchema.parse(JSON.parse(stdout));
}

// The stored items for KEYS, read from the PDFs alone.
export async function listItems(root: string, keys: string[]): Promise<StoredItem[]> {
  const stdout = await runStore(["list", root, "--", ...keys], null);
  return StoredItemListSchema.parse(JSON.parse(stdout));
}

export async function recordMetadata(
  root: string,
  key: string,
  source: TitleSource,
  metadata: { title: string; authors: string[]; year: number },
): Promise<StoredItem> {
  const authors = metadata.authors.flatMap((author) => ["--author", author]);
  const args = ["metadata", ...authors, "--year", String(metadata.year)];
  const stdout = await runStore([...args, "--", root, key, metadata.title, source], null);
  return StoredItemSchema.parse(JSON.parse(stdout));
}

export function organizationFile(root: string): string {
  return join(root, "organization.json");
}

export function readOrganization(root: string): Organization {
  return OrganizationSchema.parse(JSON.parse(readFileSync(organizationFile(root), "utf8")));
}

export function writeOrganization(root: string, organization: Organization): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(organizationFile(root), `${JSON.stringify(OrganizationSchema.parse(organization))}\n`);
}

// The index export, or null while the server has not written one yet.
export function readIndexExport(file: string): IndexExport | null {
  if (!existsSync(file)) {
    return null;
  }
  return IndexExportSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

// The filing of an item nobody has filed: its modification time is its capture time.
export function unfiled(provenance: Pick<Provenance, "captured_at">): ItemFiling {
  return {
    tags: [],
    collections: [],
    notes: [],
    reading: { status: "unread" },
    sourceCheck: { status: "unchecked" },
    mirrors: [],
    modifiedAt: provenance.captured_at,
  };
}

// A `pdf-bucket` maintenance command over the data root under XDG_DATA_HOME.
export async function bucketCommand(xdgDataHome: string, args: string[]) {
  const command = Bun.spawn([SERVER_BINARY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_DATA_HOME: xdgDataHome },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  return { stdout, stderr, exitCode };
}
