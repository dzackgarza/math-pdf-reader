// Where a stored PDF came from, checked again: whether its PDF URL and mirrors still serve the
// captured bytes (the recorded original SHA-256), and rebuilding a PDF the store has lost from
// the first of those URLs that does.

import { join } from "node:path";
import type { AppConfig } from "./config";
import type { RebuildOutcome, SourceCheck, TitleSource } from "./libraryContract";
import { recordMetadata, restorePdf, type StoredItem, storedPdfPath } from "./store";

export type DownloadSettings = AppConfig["rebuild"];

type Download = { bytes: Uint8Array<ArrayBuffer> } | { failure: string };

// The one boundary where a network rejection becomes a dead-URL outcome.
async function download(url: string, timeoutSeconds: number): Promise<Download> {
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  const response = await fetch(url, { signal }).then(
    (answer) => answer,
    (error: Error) => error,
  );
  if (response instanceof Error) {
    return { failure: response.message };
  }
  if (!response.ok) {
    return { failure: `HTTP ${response.status}` };
  }
  return response.arrayBuffer().then(
    (body) => ({ bytes: new Uint8Array(body) }),
    (error: Error) => ({ failure: error.message }),
  );
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

type Fetched =
  | { status: "accessible"; bytes: Uint8Array<ArrayBuffer> }
  | { status: "changed"; detail: string }
  | { status: "dead"; detail: string };

async function fetchOriginal(
  url: string,
  originalSha256: string,
  settings: DownloadSettings,
): Promise<Fetched> {
  const fetched = await download(url, settings.download_timeout_seconds);
  if ("failure" in fetched) {
    return { status: "dead", detail: fetched.failure };
  }
  const observed = sha256(fetched.bytes);
  if (observed !== originalSha256) {
    return { status: "changed", detail: `serves bytes hashing to ${observed}` };
  }
  return { status: "accessible", bytes: fetched.bytes };
}

export async function checkSource(
  url: string,
  originalSha256: string,
  settings: DownloadSettings,
): Promise<SourceCheck> {
  const fetched = await fetchOriginal(url, originalSha256, settings);
  const checkedAt = new Date().toISOString();
  return fetched.status === "accessible"
    ? { status: "accessible", checkedAt, detail: "serves the captured bytes" }
    : { status: fetched.status, checkedAt, detail: fetched.detail };
}

// An item the store may have lost, as the index export records it.
export type RecoverableItem = {
  key: string;
  provenance: StoredItem["provenance"];
  title: { text: string; source: TitleSource };
  authors: string[];
  mirrors: string[];
};

// Restores the item's PDF from its PDF URL, else from each mirror in turn, when the store has
// lost it. A title and authors a resolver gave are recorded again; any other title is read
// from the restored bytes as it was before.
export async function rebuildItem(
  root: string,
  item: RecoverableItem,
  settings: DownloadSettings,
): Promise<RebuildOutcome> {
  const { key, provenance } = item;
  if (storedPdfPath(root, key) !== null) {
    return { key, status: "present" };
  }
  const attempts: Extract<RebuildOutcome, { status: "unrestored" }>["attempts"] = [];
  for (const url of [provenance.pdf_url, ...item.mirrors]) {
    const fetched = await fetchOriginal(url, provenance.original_sha256, settings);
    if (fetched.status !== "accessible") {
      attempts.push({ url, status: fetched.status, detail: fetched.detail });
      continue;
    }
    await restorePdf(root, key, fetched.bytes, provenance);
    if (item.title.source === "resolver") {
      await recordMetadata(root, key, item.title.text, "resolver", item.authors);
    }
    const stored = sha256(await Bun.file(join(root, `${key}.pdf`)).bytes());
    return { key, status: "restored", from: url, stored_sha256: stored };
  }
  return { key, status: "unrestored", attempts };
}
