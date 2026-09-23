// The organization store: collections, tags, notes and saved searches, keyed by item key,
// in one JSON document under the bucket root. Provenance never lives here: deleting this
// file leaves every stored PDF and its provenance intact.
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Collection, ItemNote, SavedSearch } from "./libraryContract";
import { CollectionSchema, ItemNoteSchema, SavedSearchSchema } from "./libraryContract";

const ItemFilingSchema = z.strictObject({
  tags: z.array(z.string().min(1)),
  collections: z.array(z.string().min(1)),
  notes: z.array(ItemNoteSchema),
  modifiedAt: z.iso.datetime({ offset: true }),
});

const OrganizationSchema = z.strictObject({
  version: z.literal(1),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  items: z.record(z.string().min(1), ItemFilingSchema),
});

export type ItemFiling = z.infer<typeof ItemFilingSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;

export function organizationFile(root: string): string {
  return join(root, "organization.json");
}

// The organization of a bucket nobody has filed anything in yet.
function emptyOrganization(): Organization {
  return { version: 1, collections: [], savedSearches: [], items: {} };
}

export function unfiled(capturedAt: string): ItemFiling {
  return { tags: [], collections: [], notes: [], modifiedAt: capturedAt };
}

// --- Pure transitions --------------------------------------------------------

function fileItem(
  organization: Organization,
  key: string,
  now: string,
  change: (filing: ItemFiling) => Omit<ItemFiling, "modifiedAt">,
): Organization {
  const current = organization.items[key] ?? unfiled(now);
  return {
    ...organization,
    items: { ...organization.items, [key]: { ...change(current), modifiedAt: now } },
  };
}

// Trimmed, first occurrence kept, order preserved.
function normalizedTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()))];
}

export function setTags(org: Organization, key: string, tags: string[], now: string): Organization {
  return fileItem(org, key, now, (filing) => ({ ...filing, tags: normalizedTags(tags) }));
}

export function setCollections(
  org: Organization,
  key: string,
  collections: string[],
  now: string,
): Organization {
  return fileItem(org, key, now, (filing) => ({
    ...filing,
    collections: [...new Set(collections)],
  }));
}

export function addNote(org: Organization, key: string, note: ItemNote): Organization {
  return fileItem(org, key, note.dateAdded, (filing) => ({
    ...filing,
    notes: [...filing.notes, note],
  }));
}

export function deleteNote(
  org: Organization,
  key: string,
  noteId: string,
  now: string,
): Organization {
  return fileItem(org, key, now, (filing) => ({
    ...filing,
    notes: filing.notes.filter((note) => note.id !== noteId),
  }));
}

export function addCollection(org: Organization, collection: Collection): Organization {
  return { ...org, collections: [...org.collections, collection] };
}

export function renameCollection(org: Organization, id: string, name: string): Organization {
  return {
    ...org,
    collections: org.collections.map((collection) =>
      collection.id === id ? { ...collection, name } : collection,
    ),
  };
}

// The collection and every collection below it.
export function collectionSubtree(collections: Collection[], id: string): Set<string> {
  const subtree = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const collection of collections) {
      if (
        collection.parentId !== undefined &&
        subtree.has(collection.parentId) &&
        !subtree.has(collection.id)
      ) {
        subtree.add(collection.id);
        grew = true;
      }
    }
  }
  return subtree;
}

// Deleting a collection deletes its subcollections and takes every item out of them.
export function deleteCollection(org: Organization, id: string, now: string): Organization {
  const removed = collectionSubtree(org.collections, id);
  const items = Object.fromEntries(
    Object.entries(org.items).map(([key, filing]) => {
      if (!filing.collections.some((collection) => removed.has(collection))) {
        return [key, filing];
      }
      const collections = filing.collections.filter((collection) => !removed.has(collection));
      return [key, { ...filing, collections, modifiedAt: now }];
    }),
  );
  return {
    ...org,
    collections: org.collections.filter((collection) => !removed.has(collection.id)),
    items,
  };
}

export function addSavedSearch(org: Organization, search: SavedSearch): Organization {
  return { ...org, savedSearches: [...org.savedSearches, search] };
}

export function deleteSavedSearch(org: Organization, id: string): Organization {
  return { ...org, savedSearches: org.savedSearches.filter((search) => search.id !== id) };
}

// --- Persistence ---------------------------------------------------------------

// One store per bucket root. Writes are serialized and land by rename, so a reader never
// sees a half-written file and a response is sent only after its change is on disk.
export class OrganizationStore {
  private queue: Promise<Organization> = Promise.resolve(emptyOrganization());

  constructor(private readonly root: string) {}

  async read(): Promise<Organization> {
    const path = organizationFile(this.root);
    if (!existsSync(path)) {
      return emptyOrganization();
    }
    return OrganizationSchema.parse(JSON.parse(await readFile(path, "utf8")));
  }

  // Each change runs after the previous one settles, whether it landed or failed; a failed
  // change has already rejected its own caller's promise.
  update(change: (organization: Organization) => Organization): Promise<Organization> {
    const write = async () => {
      const next = OrganizationSchema.parse(change(await this.read()));
      const path = organizationFile(this.root);
      const partial = `${path}.partial`;
      await writeFile(partial, `${JSON.stringify(next, null, 2)}\n`);
      await rename(partial, path);
      return next;
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }
}
