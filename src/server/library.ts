// The library API: the stored items joined with their filing, and the filing mutations.
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { CONFIG_PATH, loadAppConfig } from "./config";
import {
  type ApiErrorKind,
  type BucketItem,
  CollectionsRequestSchema,
  type LibraryPayload,
  NewCollectionRequestSchema,
  NewSavedSearchRequestSchema,
  NoteRequestSchema,
  RenameCollectionRequestSchema,
  type Settings,
  TagsRequestSchema,
} from "./libraryContract";
import { type IndexedItem, LibraryIndex } from "./libraryIndex";
import {
  addCollection,
  addNote,
  addSavedSearch,
  deleteCollection,
  deleteNote,
  deleteSavedSearch,
  type Organization,
  OrganizationStore,
  organizationFile,
  renameCollection,
  setCollections,
  setTags,
  unfiled,
} from "./organization";

export function bucketItem(indexed: IndexedItem, organization: Organization): BucketItem {
  const { key, provenance } = indexed.stored;
  const filing = organization.items[key] ?? unfiled(provenance.captured_at);
  return {
    id: key,
    title: provenance.title_hint,
    url: provenance.source_url,
    tags: filing.tags,
    collections: filing.collections,
    notes: filing.notes,
    attachments: indexed.artifacts,
    dateAdded: provenance.captured_at,
    dateModified: filing.modifiedAt,
    provenance,
    file: { path: indexed.path, sizeBytes: indexed.sizeBytes },
  };
}

export type Library = {
  payload(): Promise<LibraryPayload>;
  item(key: string): Promise<{ item: BucketItem; organization: Organization } | null>;
};

function apiError(c: Context, status: 400 | 404, kind: ApiErrorKind, message: string) {
  return c.json({ error: { kind, message } }, status);
}

async function parseBody<T extends z.ZodType>(c: Context, schema: T) {
  return schema.safeParse(await c.req.json());
}

function now(): string {
  return new Date().toISOString();
}

export function registerLibraryRoutes(app: Hono, root: string): Library {
  const index = new LibraryIndex(root);
  const organizations = new OrganizationStore(root);

  const payloadOf = async (organization: Organization): Promise<LibraryPayload> => ({
    items: (await index.items()).map((indexed) => bucketItem(indexed, organization)),
    collections: organization.collections,
    savedSearches: organization.savedSearches,
  });

  const library: Library = {
    payload: async () => payloadOf(await organizations.read()),
    item: async (key) => {
      const indexed = (await index.items()).find((candidate) => candidate.stored.key === key);
      if (indexed === undefined) {
        return null;
      }
      const organization = await organizations.read();
      return { item: bucketItem(indexed, organization), organization };
    },
  };

  const storedKeys = async () =>
    new Set((await index.items()).map((indexed) => indexed.stored.key));
  const unknownItem = (c: Context, key: string) =>
    apiError(c, 404, "unknown_item", `no stored PDF has key ${key}`);
  const invalid = (c: Context, error: z.ZodError) =>
    apiError(c, 400, "invalid_request", error.message);
  const change = async (c: Context, update: (organization: Organization) => Organization) =>
    c.json(await payloadOf(await organizations.update(update)));

  app.get("/api/library", async (c) => c.json(await library.payload()));

  app.get("/api/settings", (c) => {
    const settings: Settings = {
      root,
      organizationFile: organizationFile(root),
      pdfjsVersion: loadAppConfig(CONFIG_PATH).pdfjs.version,
    };
    return c.json(settings);
  });

  app.put("/api/items/:key/tags", async (c) => {
    const key = c.req.param("key");
    const body = await parseBody(c, TagsRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await storedKeys()).has(key)) {
      return unknownItem(c, key);
    }
    return change(c, (org) => setTags(org, key, body.data.tags, now()));
  });

  app.put("/api/items/:key/collections", async (c) => {
    const key = c.req.param("key");
    const body = await parseBody(c, CollectionsRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await storedKeys()).has(key)) {
      return unknownItem(c, key);
    }
    const known = new Set(
      (await organizations.read()).collections.map((collection) => collection.id),
    );
    const unknown = body.data.collections.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return apiError(c, 400, "unknown_collection", `no collection has id ${unknown.join(", ")}`);
    }
    return change(c, (org) => setCollections(org, key, body.data.collections, now()));
  });

  app.post("/api/items/:key/notes", async (c) => {
    const key = c.req.param("key");
    const body = await parseBody(c, NoteRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await storedKeys()).has(key)) {
      return unknownItem(c, key);
    }
    const at = now();
    const note = { id: crypto.randomUUID(), note: body.data.note, dateAdded: at, dateModified: at };
    return change(c, (org) => addNote(org, key, note));
  });

  app.delete("/api/items/:key/notes/:noteId", async (c) => {
    const { key, noteId } = c.req.param();
    const filing = (await organizations.read()).items[key];
    if (filing === undefined || !filing.notes.some((note) => note.id === noteId)) {
      return apiError(c, 404, "unknown_note", `item ${key} has no note ${noteId}`);
    }
    return change(c, (org) => deleteNote(org, key, noteId, now()));
  });

  app.post("/api/collections", async (c) => {
    const body = await parseBody(c, NewCollectionRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    const { parentId } = body.data;
    const collections = (await organizations.read()).collections;
    if (parentId !== undefined && !collections.some((collection) => collection.id === parentId)) {
      return apiError(c, 400, "unknown_collection", `no collection has id ${parentId}`);
    }
    const collection = { ...body.data, id: crypto.randomUUID() };
    await organizations.update((org) => addCollection(org, collection));
    return c.json(collection);
  });

  const knownCollection = async (id: string) =>
    (await organizations.read()).collections.some((collection) => collection.id === id);

  app.patch("/api/collections/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, RenameCollectionRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await knownCollection(id))) {
      return apiError(c, 404, "unknown_collection", `no collection has id ${id}`);
    }
    return change(c, (org) => renameCollection(org, id, body.data.name));
  });

  app.delete("/api/collections/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await knownCollection(id))) {
      return apiError(c, 404, "unknown_collection", `no collection has id ${id}`);
    }
    return change(c, (org) => deleteCollection(org, id, now()));
  });

  app.post("/api/saved-searches", async (c) => {
    const body = await parseBody(c, NewSavedSearchRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    const search = { ...body.data, id: crypto.randomUUID() };
    await organizations.update((org) => addSavedSearch(org, search));
    return c.json(search);
  });

  app.delete("/api/saved-searches/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await organizations.read()).savedSearches.some((search) => search.id === id)) {
      return apiError(c, 404, "unknown_saved_search", `no saved search has id ${id}`);
    }
    return change(c, (org) => deleteSavedSearch(org, id));
  });

  return library;
}
