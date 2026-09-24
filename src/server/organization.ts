// The organization store: collections, tags, notes and saved searches, keyed by item key,
// in one JSON document under the bucket root. Provenance never lives here: deleting this
// file leaves every stored PDF and its provenance intact.
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  Activity,
  Collection,
  CollectionUpdate,
  ItemNote,
  Reading,
  SavedSearch,
  SourceCheck,
  ZoteroRecord,
} from "./libraryContract";
import {
  ActivitySchema,
  CollectionSchema,
  collectionSubtree,
  ItemNoteSchema,
  MirrorSchema,
  PreferencesSchema,
  ReadingSchema,
  SavedSearchSchema,
  SourceCheckSchema,
  ZoteroRecordSchema,
} from "./libraryContract";

export const ItemFilingSchema = z.strictObject({
  tags: z.array(z.string().min(1)),
  collections: z.array(z.string().min(1)),
  notes: z.array(ItemNoteSchema),
  reading: ReadingSchema,
  // The last check of the PDF URL, and the item's mirrors with theirs.
  sourceCheck: SourceCheckSchema,
  mirrors: z.array(MirrorSchema),
  modifiedAt: z.iso.datetime({ offset: true }),
  // Present once a send has created the item in Zotero.
  zotero: ZoteroRecordSchema.optional(),
});

const OrganizationSchema = z.strictObject({
  version: z.literal(2),
  collections: z.array(CollectionSchema),
  savedSearches: z.array(SavedSearchSchema),
  items: z.record(z.string().min(1), ItemFilingSchema),
  // Filing changes per collection, oldest first, the latest ACTIVITY_KEPT of them.
  activity: z.array(ActivitySchema),
  preferences: PreferencesSchema,
});

const ACTIVITY_KEPT = 500;

export type ItemFiling = z.infer<typeof ItemFilingSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;

export function organizationFile(root: string): string {
  return join(root, "organization.json");
}

// The organization of a bucket nobody has filed anything in yet.
export function emptyOrganization(): Organization {
  return {
    version: 2,
    collections: [],
    savedSearches: [],
    items: {},
    activity: [],
    preferences: { outlineOnOpen: false },
  };
}

export function unfiled(capturedAt: string): ItemFiling {
  return {
    tags: [],
    collections: [],
    notes: [],
    reading: { status: "unread" },
    sourceCheck: { status: "unchecked" },
    mirrors: [],
    modifiedAt: capturedAt,
  };
}

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

// Adds TAGS and COLLECTIONS to each of KEYS, after what each item already has.
export function fileMany(
  org: Organization,
  keys: string[],
  additions: { tags: string[]; collections: string[] },
  now: string,
): Organization {
  return keys.reduce(
    (current, key) =>
      fileItem(current, key, now, (filing) => ({
        ...filing,
        tags: normalizedTags([...filing.tags, ...additions.tags]),
        collections: [...new Set([...filing.collections, ...additions.collections])],
      })),
    org,
  );
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

export function setZoteroRecord(
  org: Organization,
  key: string,
  record: ZoteroRecord,
  now: string,
): Organization {
  return fileItem(org, key, now, (filing) => ({ ...filing, zotero: record }));
}

// Where the reader was: not a filing change, so the item's modification time stays (an item
// never filed keeps its capture time, as `unfiled` gives it).
export function setReading(
  org: Organization,
  key: string,
  capturedAt: string,
  reading: Reading,
): Organization {
  const filing = org.items[key] ?? unfiled(capturedAt);
  return { ...org, items: { ...org.items, [key]: { ...filing, reading } } };
}

export function addMirror(org: Organization, key: string, url: string, now: string): Organization {
  return fileItem(org, key, now, (filing) => ({
    ...filing,
    mirrors: filing.mirrors.some((mirror) => mirror.url === url)
      ? filing.mirrors
      : [...filing.mirrors, { url, check: { status: "unchecked" } }],
  }));
}

export function removeMirror(
  org: Organization,
  key: string,
  url: string,
  now: string,
): Organization {
  return fileItem(org, key, now, (filing) => ({
    ...filing,
    mirrors: filing.mirrors.filter((mirror) => mirror.url !== url),
  }));
}

// The outcome of checking the PDF URL and the mirrors (by URL): not a filing change.
export function recordSourceChecks(
  org: Organization,
  key: string,
  capturedAt: string,
  sourceCheck: SourceCheck,
  mirrorChecks: Map<string, SourceCheck>,
): Organization {
  const filing = org.items[key] ?? unfiled(capturedAt);
  const mirrors = filing.mirrors.map((mirror) => ({
    ...mirror,
    check: mirrorChecks.get(mirror.url) ?? mirror.check,
  }));
  return { ...org, items: { ...org.items, [key]: { ...filing, sourceCheck, mirrors } } };
}

// The item left the bucket (deleted, or sent to Zotero): its filing goes with it.
export function removeItem(org: Organization, key: string): Organization {
  return {
    ...org,
    items: Object.fromEntries(Object.entries(org.items).filter(([k]) => k !== key)),
  };
}

export function addCollection(org: Organization, collection: Collection): Organization {
  return { ...org, collections: [...org.collections, collection] };
}

export function updateCollection(
  org: Organization,
  id: string,
  update: CollectionUpdate,
): Organization {
  return {
    ...org,
    collections: org.collections.map((collection) =>
      collection.id === id ? { ...collection, ...update } : collection,
    ),
  };
}

export function logActivity(org: Organization, entries: Activity[]): Organization {
  return { ...org, activity: [...org.activity, ...entries].slice(-ACTIVITY_KEPT) };
}

// The collections holding any of KEYS, with how many of KEYS each holds.
export function collectionsHolding(org: Organization, keys: string[]): Map<string, number> {
  const held = new Map<string, number>();
  for (const key of keys) {
    for (const id of org.items[key]?.collections ?? []) {
      held.set(id, (held.get(id) ?? 0) + 1);
    }
  }
  return held;
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

export function replaceSavedSearch(org: Organization, search: SavedSearch): Organization {
  return {
    ...org,
    savedSearches: org.savedSearches.map((saved) => (saved.id === search.id ? search : saved)),
  };
}

export function deleteSavedSearch(org: Organization, id: string): Organization {
  return { ...org, savedSearches: org.savedSearches.filter((search) => search.id !== id) };
}

// One store per bucket root. Writes are serialized and land by rename, so a reader never
// sees a half-written file and a response is sent only after its change is on disk.
export class OrganizationStore {
  private queue: Promise<Organization> = Promise.resolve(emptyOrganization());
  private readonly writeListeners: (() => void)[] = [];

  constructor(private readonly root: string) {}

  // LISTENER runs after every write that landed.
  onWrite(listener: () => void): void {
    this.writeListeners.push(listener);
  }

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
      for (const listener of this.writeListeners) {
        listener();
      }
      return next;
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }
}
