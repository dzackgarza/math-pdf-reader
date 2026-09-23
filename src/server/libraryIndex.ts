// The library index: every stored PDF under the root with its embedded provenance, its
// size, and the extraction beside it. Derived from the files on every read;
// provenance is re-read from a PDF only when that file is new or has changed.
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Extraction } from "./libraryContract";
import { listItems, type StoredItem } from "./store";

type Artifact = Extract<Extraction, { status: "extracted" }>["markdown"];

export type IndexedItem = {
  stored: StoredItem;
  path: string;
  sizeBytes: number;
  extraction: Extraction;
};

type CachedRead = { signature: string; stored: StoredItem };

async function artifact(path: string, name: string): Promise<Artifact> {
  return { name, path, sizeBytes: (await stat(path)).size };
}

// The extraction beside a stored PDF. The runner moves `<key>.extraction/` into place first
// and `<key>.md` last, so only the Markdown marks a complete extraction.
async function extractionFor(root: string, key: string, names: Set<string>): Promise<Extraction> {
  if (!names.has(`${key}.md`)) {
    return { status: "none" };
  }
  const directory = join(root, `${key}.extraction`);
  const inside = names.has(`${key}.extraction`)
    ? await readdir(directory, { recursive: true, withFileTypes: true })
    : [];
  const files = inside
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return {
    status: "extracted",
    markdown: await artifact(join(root, `${key}.md`), `${key}.md`),
    files: await Promise.all(files.map((path) => artifact(path, relative(directory, path)))),
  };
}

export class LibraryIndex {
  private readonly reads = new Map<string, CachedRead>();
  private refreshing: Promise<IndexedItem[]> = Promise.resolve([]);

  constructor(private readonly root: string) {}

  // Refreshes run one at a time so concurrent requests never read the same PDF twice.
  items(): Promise<IndexedItem[]> {
    const refresh = () => this.refresh();
    this.refreshing = this.refreshing.then(refresh, refresh);
    return this.refreshing;
  }

  private async refresh(): Promise<IndexedItem[]> {
    const names = new Set(await readdir(this.root));
    const keys = [...names]
      .filter((name) => name.endsWith(".pdf"))
      .map((name) => name.slice(0, -4));
    const files = await Promise.all(
      keys.sort().map(async (key) => {
        const path = join(this.root, `${key}.pdf`);
        const fact = await stat(path);
        return { key, path, sizeBytes: fact.size, signature: `${fact.mtimeMs}:${fact.size}` };
      }),
    );

    const changed = files.filter((file) => this.reads.get(file.key)?.signature !== file.signature);
    if (changed.length > 0) {
      const stored = new Map(
        (
          await listItems(
            this.root,
            changed.map((file) => file.key),
          )
        ).map((item) => [item.key, item]),
      );
      for (const file of changed) {
        const item = stored.get(file.key);
        if (item === undefined) {
          throw new Error(`the store listing omitted ${file.key}`);
        }
        this.reads.set(file.key, { signature: file.signature, stored: item });
      }
    }
    for (const key of this.reads.keys()) {
      if (!names.has(`${key}.pdf`)) {
        this.reads.delete(key);
      }
    }

    return Promise.all(
      files.map(async (file) => ({
        stored: this.cached(file.key),
        path: file.path,
        sizeBytes: file.sizeBytes,
        extraction: await extractionFor(this.root, file.key, names),
      })),
    );
  }

  private cached(key: string): StoredItem {
    const read = this.reads.get(key);
    if (read === undefined) {
      throw new Error(`the index holds no read of ${key}`);
    }
    return read.stored;
  }
}
