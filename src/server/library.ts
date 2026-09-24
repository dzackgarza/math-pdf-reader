// The library API: the stored items joined with their filing, and the filing mutations.
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { CONFIG_PATH, loadAppConfig } from "./config";
import type { IndexExporter } from "./indexExport";
import {
  type ApiErrorKind,
  type BucketItem,
  CollectionsRequestSchema,
  type LibraryPayload,
  NewCollectionRequestSchema,
  NewSavedSearchRequestSchema,
  NoteRequestSchema,
  RenameCollectionRequestSchema,
  type RetrieveMetadataResponse,
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
import { sendRoutes, zoteroStatus } from "./send";
import { replacePdf } from "./store";
import { retrieveMetadata } from "./titles";
import type { ZoteroWriteApi } from "./zotero";

export function bucketItem(indexed: IndexedItem, organization: Organization): BucketItem {
  const { key, provenance } = indexed.stored;
  const filing = organization.items[key] ?? unfiled(provenance.captured_at);
  return {
    id: key,
    title: indexed.stored.title.text,
    titleSource: indexed.stored.title.source,
    authors: indexed.stored.authors,
    url: provenance.source_url,
    tags: filing.tags,
    collections: filing.collections,
    notes: filing.notes,
    extraction: indexed.extraction,
    zotero: zoteroStatus(filing.zotero, indexed.extraction),
    dateAdded: provenance.captured_at,
    dateModified: filing.modifiedAt,
    provenance,
    file: { path: indexed.path, sizeBytes: indexed.sizeBytes },
  };
}

export type Library = {
  payload(): Promise<LibraryPayload>;
  item(key: string): Promise<{ item: BucketItem; organization: Organization } | null>;
  // A PDF was stored: the index export is rewritten.
  stored(): void;
  // Items left the bucket on purpose: the index export drops them.
  removed(keys: string[]): void;
};

function apiError(c: Context, status: 400 | 404 | 409, kind: ApiErrorKind, message: string) {
  return c.json({ error: { kind, message } }, status);
}

function invalid(c: Context, error: z.ZodError) {
  return apiError(c, 400, "invalid_request", error.message);
}

function unknownCollection(c: Context, id: string) {
  return apiError(c, 404, "unknown_collection", `no collection has id ${id}`);
}

async function parseBody<T extends z.ZodType>(c: Context, schema: T) {
  return schema.safeParse(await c.req.json());
}

function now(): string {
  return new Date().toISOString();
}

// The stored items and their filing for one bucket root, shared by the route groups.
export class LibraryState {
  readonly index: LibraryIndex;
  readonly organizations: OrganizationStore;

  constructor(
    root: string,
    readonly exporter: IndexExporter | null,
  ) {
    this.index = new LibraryIndex(root);
    this.organizations = new OrganizationStore(root);
    this.organizations.onWrite(() => exporter?.changed());
  }

  async payloadOf(organization: Organization): Promise<LibraryPayload> {
    return {
      items: (await this.index.items()).map((indexed) => bucketItem(indexed, organization)),
      collections: organization.collections,
      savedSearches: organization.savedSearches,
    };
  }

  async indexed(key: string): Promise<IndexedItem | undefined> {
    return (await this.index.items()).find((indexed) => indexed.stored.key === key);
  }

  async isStored(key: string): Promise<boolean> {
    return (await this.indexed(key)) !== undefined;
  }

  async collectionIds(): Promise<Set<string>> {
    return new Set(
      (await this.organizations.read()).collections.map((collection) => collection.id),
    );
  }

  // Applies a filing change and answers with the library as it now stands.
  async change(c: Context, update: (organization: Organization) => Organization) {
    return c.json(await this.payloadOf(await this.organizations.update(update)));
  }
}

function itemRoutes(app: Hono, state: LibraryState, root: string, resolversManifest: string) {
  const unknownItem = (c: Context, key: string) =>
    apiError(c, 404, "unknown_item", `no stored PDF has key ${key}`);

  // "Retrieve metadata": run the identifier resolvers again and answer with the item as it
  // now stands; a resolver that fails leaves the title as it was.
  app.post("/api/items/:key/metadata", async (c) => {
    const key = c.req.param("key");
    if (!(await state.isStored(key))) {
      return unknownItem(c, key);
    }
    const outcome = await retrieveMetadata(root, key, resolversManifest);
    const indexed = await state.indexed(key);
    if (indexed === undefined) {
      throw new Error(`${key} left the store while its metadata was retrieved`);
    }
    const response: RetrieveMetadataResponse = {
      outcome,
      item: bucketItem(indexed, await state.organizations.read()),
    };
    return c.json(response);
  });

  // The reader's save: the PDF with its annotations written in by PDF.js.
  app.put("/api/items/:key/pdf", async (c) => {
    const key = c.req.param("key");
    if (!(await state.isStored(key))) {
      return unknownItem(c, key);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
      return apiError(c, 400, "invalid_request", "the request body is not a PDF");
    }
    const outcome = await replacePdf(root, key, bytes);
    if (outcome.status === "provenance_mismatch") {
      const message = `the PDF does not carry the provenance embedded in ${key}`;
      return apiError(c, 409, "provenance_mismatch", message);
    }
    const indexed = await state.indexed(key);
    if (indexed === undefined) {
      throw new Error(`${key} left the store while its PDF was replaced`);
    }
    return c.json(bucketItem(indexed, await state.organizations.read()));
  });

  app.put("/api/items/:key/tags", async (c) => {
    const key = c.req.param("key");
    const body = await parseBody(c, TagsRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await state.isStored(key))) {
      return unknownItem(c, key);
    }
    return state.change(c, (org) => setTags(org, key, body.data.tags, now()));
  });

  app.put("/api/items/:key/collections", async (c) => {
    const key = c.req.param("key");
    const body = await parseBody(c, CollectionsRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await state.isStored(key))) {
      return unknownItem(c, key);
    }
    const known = await state.collectionIds();
    const unknown = body.data.collections.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return apiError(c, 400, "unknown_collection", `no collection has id ${unknown.join(", ")}`);
    }
    return state.change(c, (org) => setCollections(org, key, body.data.collections, now()));
  });

  app.post("/api/items/:key/notes", async (c) => {
    const key = c.req.param("key");
    const body = await parseBody(c, NoteRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await state.isStored(key))) {
      return unknownItem(c, key);
    }
    const at = now();
    const note = { id: crypto.randomUUID(), note: body.data.note, dateAdded: at, dateModified: at };
    return state.change(c, (org) => addNote(org, key, note));
  });

  app.delete("/api/items/:key/notes/:noteId", async (c) => {
    const { key, noteId } = c.req.param();
    const filing = (await state.organizations.read()).items[key];
    if (filing === undefined || !filing.notes.some((note) => note.id === noteId)) {
      return apiError(c, 404, "unknown_note", `item ${key} has no note ${noteId}`);
    }
    return state.change(c, (org) => deleteNote(org, key, noteId, now()));
  });
}

function collectionRoutes(app: Hono, state: LibraryState) {
  app.post("/api/collections", async (c) => {
    const body = await parseBody(c, NewCollectionRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    const { parentId } = body.data;
    if (parentId !== undefined && !(await state.collectionIds()).has(parentId)) {
      return apiError(c, 400, "unknown_collection", `no collection has id ${parentId}`);
    }
    const collection = { ...body.data, id: crypto.randomUUID() };
    await state.organizations.update((org) => addCollection(org, collection));
    return c.json(collection);
  });

  app.patch("/api/collections/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, RenameCollectionRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await state.collectionIds()).has(id)) {
      return unknownCollection(c, id);
    }
    return state.change(c, (org) => renameCollection(org, id, body.data.name));
  });

  app.delete("/api/collections/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await state.collectionIds()).has(id)) {
      return unknownCollection(c, id);
    }
    return state.change(c, (org) => deleteCollection(org, id, now()));
  });
}

function savedSearchRoutes(app: Hono, state: LibraryState) {
  app.post("/api/saved-searches", async (c) => {
    const body = await parseBody(c, NewSavedSearchRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    const search = { ...body.data, id: crypto.randomUUID() };
    await state.organizations.update((org) => addSavedSearch(org, search));
    return c.json(search);
  });

  app.delete("/api/saved-searches/:id", async (c) => {
    const id = c.req.param("id");
    const saved = (await state.organizations.read()).savedSearches;
    if (!saved.some((search) => search.id === id)) {
      return apiError(c, 404, "unknown_saved_search", `no saved search has id ${id}`);
    }
    return state.change(c, (org) => deleteSavedSearch(org, id));
  });
}

export function registerLibraryRoutes(
  app: Hono,
  root: string,
  zotero: ZoteroWriteApi,
  resolversManifest: string,
  exporter: IndexExporter | null,
): Library {
  const state = new LibraryState(root, exporter);
  const library: Library = {
    stored: () => exporter?.changed(),
    removed: (keys) => {
      exporter?.forget(keys);
      exporter?.changed();
    },
    payload: async () => state.payloadOf(await state.organizations.read()),
    item: async (key) => {
      const indexed = await state.indexed(key);
      if (indexed === undefined) {
        return null;
      }
      const organization = await state.organizations.read();
      return { item: bucketItem(indexed, organization), organization };
    },
  };

  app.get("/api/library", async (c) => c.json(await library.payload()));
  app.get("/api/settings", (c) => {
    const settings: Settings = {
      root,
      organizationFile: organizationFile(root),
      pdfjsVersion: loadAppConfig(CONFIG_PATH).pdfjs.version,
    };
    return c.json(settings);
  });
  itemRoutes(app, state, root, resolversManifest);
  collectionRoutes(app, state);
  savedSearchRoutes(app, state);
  sendRoutes(app, state, root, zotero, library);
  return library;
}
