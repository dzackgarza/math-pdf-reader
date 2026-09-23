// The library index: every stored PDF under the root with its embedded provenance, its
// size, and the extraction artifacts beside it. Derived from the files on every read;
// provenance is re-read from a PDF only when that file is new or has changed.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listItems, type StoredItem } from "./store";

export type Artifact = { id: string; title: string; path: string };

export type IndexedItem = {
  stored: StoredItem;
  path: string;
  sizeBytes: number;
  artifacts: Artifact[];
};

type CachedRead = { signature: string; stored: StoredItem };

// Extraction plugins write `<key>.md` and files under `<key>.extraction/` beside the PDF.
async function artifactsFor(root: string, key: string, names: Set<string>): Promise<Artifact[]> {
  const found: string[] = [];
  if (names.has(`${key}.extraction`)) {
    const inside = await readdir(join(root, `${key}.extraction`), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of inside.filter((dirent) => dirent.isFile())) {
      const relative = join(entry.parentPath, entry.name).slice(root.length + 1);
      found.push(relative);
    }
  }
  if (names.has(`${key}.md`)) {
    found.push(`${key}.md`);
  }
  return found
    .sort()
    .map((id) => ({ id, title: id.slice(id.lastIndexOf("/") + 1), path: join(root, id) }));
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
        artifacts: await artifactsFor(this.root, file.key, names),
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
