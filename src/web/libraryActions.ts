// What the window's filing controls do: each asks for what it needs (a name, a
// confirmation), calls the library API, and moves to the result.

import type { ExtractionOutcome } from "../server/extractionContract";
import {
  type AdvancedSearchSettings,
  type BucketItem,
  CollectionSchema,
  LibraryPayloadSchema,
  RetrieveMetadataResponseSchema,
  SavedSearchSchema,
  SendResponseSchema,
} from "../server/libraryContract";
import type { ConfirmRequest } from "./components/ConfirmDialog";
import type { ItemFilingActions } from "./components/InspectorPanel";
import type { NameRequest } from "./components/NameDialog";
import { organizationPath } from "./routes";
import type { OrganizationActions } from "./screens/OrganizationScreen";
import { runExtraction } from "./useExtractionPlugins";
import { BucketRequestError, type Mutate } from "./useLibraryApi";

export type ActionContext = {
  mutate: Mutate;
  // Reads the library again, for a failed call that may still have changed it.
  refresh: () => void;
  navigate: (path: string) => void;
  askName: (request: NameRequest) => void;
  confirm: (request: ConfirmRequest) => void;
  // A failed call leaves the library as the server holds it; this says why.
  report: (message: string) => void;
};

function run<T>(context: ActionContext, action: Promise<T>): void {
  action.then(
    () => undefined,
    (error: Error) => context.report(error.message),
  );
}

function itemPath(key: string): string {
  return `/api/items/${encodeURIComponent(key)}`;
}

function newCollection(context: ActionContext, name: string) {
  return context.mutate(CollectionSchema, "POST", "/api/collections", { name });
}

function fileIn(context: ActionContext, item: BucketItem, collectionId: string) {
  return context.mutate(LibraryPayloadSchema, "PUT", `${itemPath(item.id)}/collections`, {
    collections: [...item.collections, collectionId],
  });
}

function setTags(context: ActionContext, item: BucketItem, tags: string[]) {
  return context.mutate(LibraryPayloadSchema, "PUT", `${itemPath(item.id)}/tags`, { tags });
}

export function filingActions(context: ActionContext, item: BucketItem): ItemFilingActions {
  const change = (method: "PUT" | "POST" | "DELETE", path: string, body?: object) =>
    run(context, context.mutate(LibraryPayloadSchema, method, `${itemPath(item.id)}${path}`, body));
  return {
    setTags: (tags) => change("PUT", "/tags", { tags }),
    setCollections: (collections) => change("PUT", "/collections", { collections }),
    fileInNewCollection: (name) =>
      run(
        context,
        newCollection(context, name).then((collection) => fileIn(context, item, collection.id)),
      ),
    addNote: (note) => change("POST", "/notes", { note }),
    deleteNote: (noteId) => change("DELETE", `/notes/${encodeURIComponent(noteId)}`),
  };
}

// What the row context menu does to one item.
export type ItemMenuActions = {
  retrieveMetadata: () => void;
  fileIn: (collectionId: string) => void;
  fileInNewCollection: () => void;
  addTag: () => void;
  delete: () => void;
};

export function itemMenuActions(
  context: ActionContext,
  item: BucketItem,
  onDeleted: () => void,
): ItemMenuActions {
  return {
    // Zotero's "Retrieve Metadata": the title from an identifier resolver, else the PDF.
    retrieveMetadata: () =>
      run(
        context,
        context
          .mutate(RetrieveMetadataResponseSchema, "POST", `${itemPath(item.id)}/metadata`)
          .then(({ outcome }) => {
            context.refresh();
            if (outcome.status === "unidentified") {
              context.report("No identifier found");
            }
            if (outcome.status === "failed") {
              context.report(`${outcome.pluginId} on ${outcome.identifier}: ${outcome.message}`);
            }
          }),
      ),
    fileIn: (collectionId) => run(context, fileIn(context, item, collectionId)),
    fileInNewCollection: () =>
      context.askName({
        title: "New collection",
        label: "Name",
        submitLabel: "Create",
        initialName: "",
        onSubmit: (name) =>
          run(
            context,
            newCollection(context, name).then((collection) => fileIn(context, item, collection.id)),
          ),
      }),
    addTag: () =>
      context.askName({
        title: "Add tag",
        label: "Name",
        submitLabel: "Add",
        initialName: "",
        onSubmit: (name) =>
          run(context, setTags(context, item, [...new Set([...item.tags, name])])),
      }),
    delete: () =>
      context.confirm({
        title: `Delete “${item.title}”?`,
        description: "The PDF moves to the trash.",
        confirmLabel: "Delete",
        onConfirm: () =>
          run(
            context,
            context.mutate(LibraryPayloadSchema, "DELETE", itemPath(item.id)).then(onDeleted),
          ),
      }),
  };
}

export function createCollection(context: ActionContext, parentId?: string): void {
  context.askName({
    title: parentId === undefined ? "New collection" : "New subcollection",
    label: "Name",
    submitLabel: "Create",
    initialName: "",
    onSubmit: (name) =>
      run(
        context,
        context
          .mutate(CollectionSchema, "POST", "/api/collections", { name, parentId })
          .then((collection) => context.navigate(organizationPath("collections", collection.id))),
      ),
  });
}

export function saveSearch(
  context: ActionContext,
  search: AdvancedSearchSettings,
  onSaved: () => void,
): void {
  context.askName({
    title: "Save search",
    label: "Name",
    submitLabel: "Save",
    initialName: search.query.trim(),
    onSubmit: (name) =>
      run(
        context,
        context
          .mutate(SavedSearchSchema, "POST", "/api/saved-searches", { name, search })
          .then((saved) => {
            onSaved();
            context.navigate(organizationPath("saved", saved.id));
          }),
      ),
  });
}

// Confirms, deletes, and leaves the page of the thing deleted.
function deleteAndLeave(
  context: ActionContext,
  request: Omit<ConfirmRequest, "onConfirm">,
  path: string,
  leaveTo: string,
): void {
  context.confirm({
    ...request,
    onConfirm: () =>
      run(
        context,
        context.mutate(LibraryPayloadSchema, "DELETE", path).then(() => context.navigate(leaveTo)),
      ),
  });
}

export function organizationActions(context: ActionContext): OrganizationActions {
  return {
    newSubcollection: (parent) => createCollection(context, parent.id),
    renameCollection: (collection) =>
      context.askName({
        title: "Rename collection",
        label: "Name",
        submitLabel: "Rename",
        initialName: collection.name,
        onSubmit: (name) =>
          run(
            context,
            context.mutate(
              LibraryPayloadSchema,
              "PATCH",
              `/api/collections/${encodeURIComponent(collection.id)}`,
              { name },
            ),
          ),
      }),
    deleteCollection: (collection) =>
      deleteAndLeave(
        context,
        {
          title: `Delete “${collection.name}”?`,
          description:
            "The collection and its subcollections are deleted. The PDFs in them stay in the library with their tags and notes.",
          confirmLabel: "Delete collection",
        },
        `/api/collections/${encodeURIComponent(collection.id)}`,
        organizationPath("collections"),
      ),
    deleteSavedSearch: (saved) =>
      deleteAndLeave(
        context,
        {
          title: `Delete “${saved.name}”?`,
          description: "The stored search is deleted. No PDF changes.",
          confirmLabel: "Delete search",
        },
        `/api/saved-searches/${encodeURIComponent(saved.id)}`,
        organizationPath("saved"),
      ),
  };
}

// What the window shows about a send while it runs or after it failed; a completed send takes
// the item out of the bucket.
export type SendAttempt =
  | { kind: "sending" }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string };

export function sendToZotero(
  context: ActionContext,
  key: string,
  onAttempt: (attempt: SendAttempt | null) => void,
): void {
  onAttempt({ kind: "sending" });
  context.mutate(SendResponseSchema, "POST", `${itemPath(key)}/zotero`).then(
    () => {
      onAttempt(null);
      // The item is in Zotero now and no longer in the bucket.
      context.refresh();
    },
    (error: Error) => {
      // A failed send may have recorded its Zotero item before the failing step.
      context.refresh();
      const refused = error instanceof BucketRequestError && error.kind === "already_sent";
      onAttempt({ kind: refused ? "refused" : "failed", message: error.message });
    },
  );
}

// An extraction run on an item: in progress, answered with its outcome, or refused by the
// server before any plugin ran.
export type ExtractionAttempt =
  | { kind: "running"; pluginId: string }
  | { kind: "finished"; outcome: ExtractionOutcome }
  | { kind: "error"; message: string };

export function extractWith(
  context: ActionContext,
  key: string,
  pluginId: string,
  onAttempt: (attempt: ExtractionAttempt) => void,
): void {
  onAttempt({ kind: "running", pluginId });
  runExtraction(key, pluginId).then(
    (outcome) => {
      // A succeeded run placed files beside the PDF; the item's extraction is derived from them.
      context.refresh();
      onAttempt({ kind: "finished", outcome });
    },
    (error: Error) => onAttempt({ kind: "error", message: error.message }),
  );
}
