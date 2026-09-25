// A bucket below its HTTP API, for tests that set one up or inspect it: the stored PDFs read
// back by the pikepdf commands (`pdfbucket`), the documents beside them, and the `pdf-bucket`
// maintenance commands.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CaptureResponseSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig, STORE_COMMAND } from "../src/contract/config";
import {
  type IndexExport,
  IndexExportSchema,
  type ItemFiling,
  type Organization,
  OrganizationSchema,
} from "../src/contract/files";
import type { Provenance, TitleSource } from "../src/contract/library";
import { ReadOutcomeListSchema, type StoredItem } from "../src/contract/store";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, SERVER_BINARY, serveBucket } from "./bucket";

async function runStore(args: string[]): Promise<Uint8Array> {
  const store = Bun.spawn([...STORE_COMMAND, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(store.stdout).bytes(),
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

// Captures an upload into ROOT through a server of its own, as the extension does; answers the
// key it was stored under.
export async function captureBytes(root: string, upload: Upload): Promise<string> {
  const server = await serveBucket({
    root,
    zoteroUrl: loadAppConfig(CONFIG_PATH).zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  const form = new FormData();
  form.set("pdf", new File([upload.bytes], upload.filename, { type: "application/pdf" }));
  form.set("pdf_url", upload.pdfUrl);
  form.set("source_url", upload.sourceUrl);
  form.set("title_hint", upload.titleHint);
  const response = await server.request("/capture-bytes", { method: "POST", body: form });
  const text = await response.text();
  await server.stop();
  if (!response.ok) {
    throw new Error(`the capture of ${upload.filename} failed (${response.status}): ${text}`);
  }
  return CaptureResponseSchema.parse(JSON.parse(text)).key;
}

// The stored items for KEYS, read from the PDFs alone.
export async function listItems(root: string, keys: string[]): Promise<StoredItem[]> {
  const paths = keys.map((key) => join(root, `${key}.pdf`));
  const stdout = await runStore(["read", "--", ...paths]);
  const outcomes = ReadOutcomeListSchema.parse(JSON.parse(new TextDecoder().decode(stdout)));
  return keys.map((key, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined || outcome.status === "unreadable") {
      throw new Error(`${key}.pdf cannot be read: ${JSON.stringify(outcome)}`);
    }
    const { provenance, title, authors, year, abstract } = outcome.record;
    return { key, provenance, title, authors, year, abstract };
  });
}

// Records resolver metadata inside a stored PDF, as a resolver's answer does.
export async function recordMetadata(
  root: string,
  key: string,
  source: TitleSource,
  metadata: { title: string; authors: string[]; year: number },
): Promise<void> {
  const path = join(root, `${key}.pdf`);
  const authors = metadata.authors.map((author) => `--author=${author}`);
  const args = ["embed-metadata", ...authors, `--year=${metadata.year}`];
  const bytes = await runStore([...args, "--", path, metadata.title, source]);
  writeFileSync(`${path}.recorded`, bytes);
  renameSync(`${path}.recorded`, path);
}

export function organizationFile(root: string): string {
  return join(root, "organization.json");
}

export function readOrganization(root: string): Organization {
  return OrganizationSchema.parse(JSON.parse(readFileSync(organizationFile(root), "utf8")));
}

export function writeOrganization(root: string, organization: Organization): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    organizationFile(root),
    `${JSON.stringify(OrganizationSchema.parse(organization))}\n`,
  );
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
