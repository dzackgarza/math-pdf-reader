// What the window's filing controls do: each asks for what it needs (a name, a
// confirmation), calls the library API, and moves to the result.
//
// Tags and collections change through the bulk add/remove routes, one item or many: a change
// names only what it adds or removes, so two changes made from stale copies of the library both
// land. Every text the user typed is trimmed before it is sent.

import type { ExtractionOutcome } from "../contract/extraction";
import {
  type AdvancedSearchSettings,
  type BucketItem,
  BucketItemSchema,
  type Collection,
  CollectionSchema,
  type CollectionUpdate,
  FolderImportResponseSchema,
  type GuessMetadataResponse,
  GuessMetadataResponseSchema,
  ImportUrlResponseSchema,
  type ManualMetadataRequest,
  type Preferences,
  type RebuildOutcome,
  RebuildOutcomeSchema,
  RetrieveMetadataResponseSchema,
  type SavedSearch,
  SavedSearchSchema,
  SendResponseSchema,
} from "../contract/library";
import {
  type ActionFailure,
  type ActionRejection,
  actionFailure,
  describeFailure,
} from "./actionFailure";
import type { ConfirmRequest } from "./components/ConfirmDialog";
import type { ItemFilingActions } from "./components/InspectorPanel";
import type { NameRequest } from "./components/NameDialog";
import { topicTag } from "./format";
import { organizationPath } from "./routes";
import type { OrganizationActions } from "./screens/OrganizationScreen";
import { trimmedRule } from "./smartRules";
import { runExtraction } from "./useExtractionPlugins";
import { BucketRequestError, type LibraryApi, request } from "./useLibraryApi";

export type ActionContext = {
  api: LibraryApi;
  // Settles KEY's open reader and closes its tab (ReaderTabsApi.closeReader).
  closeReader: (key: string) => Promise<void>;
  navigate: (path: string) => void;
  askName: (request: NameRequest) => void;
  confirm: (request: ConfirmRequest) => void;
  // A failed call leaves the library as the server holds it; this says what refused it.
  fail: (failure: ActionFailure) => void;
  error: (message: string) => void;
  progress: (message: string) => void;
  // What a call that succeeded could not do (a PDF not restored, no identifier found).
  report: (message: string) => void;
  // What a call that succeeded did, when the library does not show it by itself.
  notify: (message: string) => void;
};

// Runs a call whose failure no dialog shows: the window reports it.
export function run<T>(context: ActionContext, action: Promise<T>): void {
  action.then(
    () => undefined,
    (rejection: ActionRejection) => context.fail(actionFailure(rejection)),
  );
}

const done = () => undefined;

function populated(result: GuessMetadataResponse): string {
  const { title, authors, year } = result.metadata;
  return `${title}\nAuthors: ${authors.join(", ")}\nYear: ${year}\nModel: ${result.provider} ${result.model}`;
}

export function guessMetadata(context: ActionContext, items: BucketItem[]): void {
  const execute = async () => {
    const guessed: GuessMetadataResponse[] = [];
    const failures: string[] = [];
    for (const item of items) {
      context.progress(`Guessing metadata for “${item.title}”…`);
      const outcome = await context.api
        .call(GuessMetadataResponseSchema, "POST", `${itemPath(item.id)}/guess-metadata`)
        .then(
          (result) => ({ status: "guessed" as const, result }),
          (rejection: ActionRejection) => ({
            status: "failed" as const,
            failure: actionFailure(rejection),
          }),
        );
      if (outcome.status === "guessed") {
        guessed.push(outcome.result);
      } else {
        const failure = describeFailure(outcome.failure);
        failures.push(`${item.title}: ${failure.title}: ${failure.detail}`);
      }
    }
    const completed = guessed.map(populated).join("\n\n");
    if (failures.length > 0) {
      const populatedItems = completed === "" ? "" : `\n\nPopulated:\n${completed}`;
      context.error(`${failures.join("\n")}\n${populatedItems}`.trim());
      return;
    }
    context.notify(`Populated metadata:\n${completed}`);
  };
  void execute();
}

function itemPath(key: string): string {
  return `/api/items/${encodeURIComponent(key)}`;
}

export function saveItemMetadata(
  context: ActionContext,
  key: string,
  metadata: ManualMetadataRequest,
): Promise<void> {
  return context.api
    .call(BucketItemSchema, "PATCH", `${itemPath(key)}/metadata`, metadata)
    .then(done);
}

function newCollection(context: ActionContext, name: string, parentId?: string) {
  return context.api.call(CollectionSchema, "POST", "/api/collections", {
    name,
    parentId,
  });
}

// Creates a collection and files KEYS in it; the filing change answers with the library, which
// then holds the new collection too.
function fileInNew(context: ActionContext, keys: string[], name: string) {
  return request(CollectionSchema, "POST", "/api/collections", { name }).then((collection) =>
    changeCollections(context, keys, [collection.id], []),
  );
}

// Adds ADD to and takes REMOVE from the tags of every item in KEYS.
function changeTags(context: ActionContext, keys: string[], add: string[], remove: string[]) {
  return context.api.change("POST", "/api/bulk/tags", { keys, add, remove });
}

// Files every item in KEYS into ADD and out of REMOVE.
function changeCollections(
  context: ActionContext,
  keys: string[],
  add: string[],
  remove: string[],
) {
  return context.api.change("POST", "/api/bulk/collections", {
    keys,
    add,
    remove,
  });
}

// What the details panel does with the item's sources.
export type ItemSourceActions = {
  verify: () => void;
  addMirror: (url: string) => Promise<void>;
  removeMirror: (url: string) => void;
};

export function sourceActions(
  context: ActionContext,
  item: BucketItem,
  onVerifying: (verifying: boolean) => void,
): ItemSourceActions {
  const path = itemPath(item.id);
  return {
    verify: () => {
      onVerifying(true);
      run(
        context,
        context.api.change("POST", `${path}/verify`).finally(() => onVerifying(false)),
      );
    },
    addMirror: (url) =>
      context.api.change("POST", `${path}/mirrors`, { url: url.trim() }).then(done),
    removeMirror: (url) =>
      run(context, context.api.change("DELETE", `${path}/mirrors?url=${encodeURIComponent(url)}`)),
  };
}

// What Rebuild did, for the items no URL serves any more: each URL tried and what it served.
function reportUnrestored(context: ActionContext, outcomes: RebuildOutcome[]): void {
  const failures = outcomes.flatMap((outcome) => {
    switch (outcome.status) {
      case "unrestored": {
        const tried = outcome.attempts.map((attempt) => `${attempt.url}: ${attempt.detail}`);
        return [`${outcome.key} was not restored. ${tried.join("; ")}`];
      }
      case "failed":
        return [`${outcome.key} was not restored: ${outcome.message}`];
      case "restored":
      case "present":
        return [];
    }
  });
  if (failures.length > 0) {
    context.report(failures.join("\n"));
  }
}

// Rebuilds one lost PDF.
export function rebuildLost(context: ActionContext, key: string, onDone: () => void): void {
  run(
    context,
    context.api
      .call(RebuildOutcomeSchema, "POST", `${itemPath(key)}/rebuild`)
      .then((outcome) => reportUnrestored(context, [outcome]))
      .finally(onDone),
  );
}

// Rebuilds every lost PDF in one request.
export function rebuildAllLost(context: ActionContext, onDone: () => void): void {
  run(
    context,
    context.api
      .call(RebuildOutcomeSchema.array(), "POST", "/api/rebuild")
      .then((outcomes) => reportUnrestored(context, outcomes))
      .finally(onDone),
  );
}

export function filingActions(context: ActionContext, item: BucketItem): ItemFilingActions {
  const keys = [item.id];
  const notes = `${itemPath(item.id)}/notes`;
  return {
    addTag: (tag) => run(context, changeTags(context, keys, [tag.trim()], [])),
    removeTag: (tag) => run(context, changeTags(context, keys, [], [tag])),
    fileIn: (collectionId) => run(context, changeCollections(context, keys, [collectionId], [])),
    unfile: (collectionId) => run(context, changeCollections(context, keys, [], [collectionId])),
    fileInNewCollection: (name) => run(context, fileInNew(context, keys, name.trim())),
    addNote: (note) => context.api.change("POST", notes, { note: note.trim() }).then(done),
    deleteNote: (note) =>
      context.confirm({
        title: "Delete this note?",
        description: note.note,
        confirmLabel: "Delete note",
        onConfirm: () =>
          run(context, context.api.change("DELETE", `${notes}/${encodeURIComponent(note.id)}`)),
      }),
  };
}

// Closes KEY's reader tab once its annotations are saved, then deletes the item.
function deleteItem(context: ActionContext, key: string): Promise<void> {
  return context
    .closeReader(key)
    .then(() => context.api.change("DELETE", itemPath(key)))
    .then(done);
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
  const keys = [item.id];
  return {
    // Zotero's "Retrieve Metadata": the title from an identifier resolver, else the PDF.
    retrieveMetadata: () =>
      run(
        context,
        context.api
          .call(RetrieveMetadataResponseSchema, "POST", `${itemPath(item.id)}/metadata`)
          .then(({ outcome }) => {
            if (outcome.status === "unidentified") {
              context.report("No identifier found");
            }
            if (outcome.status === "failed") {
              context.report(`${outcome.pluginId} on ${outcome.identifier}: ${outcome.message}`);
            }
          }),
      ),
    fileIn: (collectionId) => run(context, changeCollections(context, keys, [collectionId], [])),
    fileInNewCollection: () =>
      context.askName({
        title: "New collection",
        label: "Name",
        submitLabel: "Create",
        initialName: "",
        onSubmit: (name) => fileInNew(context, keys, name).then(done),
      }),
    addTag: () =>
      context.askName({
        title: "Add tag",
        label: "Name",
        submitLabel: "Add",
        initialName: "",
        onSubmit: (name) => changeTags(context, keys, [name], []).then(done),
      }),
    delete: () =>
      context.confirm({
        title: `Delete “${item.title}”?`,
        description: "The PDF moves to the trash.",
        confirmLabel: "Delete",
        onConfirm: () => run(context, deleteItem(context, item.id).then(onDeleted)),
      }),
  };
}

// What the selection bar does to the chosen items.
export type BulkActions = {
  tag: () => void;
  file: (collectionId: string) => void;
  fileInNew: () => void;
};

export function bulkActions(context: ActionContext, keys: string[]): BulkActions {
  return {
    tag: () =>
      context.askName({
        title: `Add a tag to ${keys.length} PDFs`,
        label: "Name",
        submitLabel: "Add",
        initialName: "",
        onSubmit: (name) => changeTags(context, keys, [name], []).then(done),
      }),
    file: (collectionId) => run(context, changeCollections(context, keys, [collectionId], [])),
    fileInNew: () =>
      context.askName({
        title: "New collection",
        label: "Name",
        submitLabel: "Create",
        initialName: "",
        onSubmit: (name) => fileInNew(context, keys, name).then(done),
      }),
  };
}

// Import URL and Add Folder: each asks for its one line, stores what it finds, and shows the
// new item (for a folder, reports how many PDFs were new).
export function importUrl(context: ActionContext, onImported: (key: string) => void): void {
  context.askName({
    title: "Import URL",
    label: "A PDF URL, or a page that links its PDF (arXiv, a journal)",
    submitLabel: "Import",
    initialName: "",
    onSubmit: (url) =>
      context.api
        .call(ImportUrlResponseSchema, "POST", "/api/import-url", { url })
        .then(({ key }) => onImported(key)),
  });
}

export function addFolder(
  context: ActionContext,
  browse: (() => Promise<string | null>) | null,
): void {
  context.askName({
    title: "Add Folder",
    label: "Every PDF directly in this folder",
    submitLabel: "Add",
    initialName: "",
    ...(browse === null ? {} : { browse }),
    onSubmit: (path) =>
      context.api
        .call(FolderImportResponseSchema, "POST", "/api/import-folder", {
          path,
        })
        .then(({ files }) => {
          const count = (status: string) => files.filter((file) => file.status === status).length;
          const stored = count("stored");
          context.notify(
            `Added ${stored} ${stored === 1 ? "PDF" : "PDFs"}; ${count("existing")} already in the library; ${count("not_a_pdf")} not PDFs; ${count("failed")} failed`,
          );
        }),
  });
}

export function createCollection(context: ActionContext, parentId?: string): void {
  context.askName({
    title: parentId === undefined ? "New collection" : "New subcollection",
    label: "Name",
    submitLabel: "Create",
    initialName: "",
    onSubmit: (name) =>
      newCollection(context, name, parentId).then((collection) =>
        context.navigate(organizationPath("collections", collection.id)),
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
      context.api
        .call(SavedSearchSchema, "POST", "/api/saved-searches", {
          name,
          match: "all",
          rules: [{ field: "text", operator: "matches", search }],
        })
        .then((saved) => {
          onSaved();
          context.navigate(organizationPath("saved", saved.id));
        }),
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
        context.api.change("DELETE", path).then(() => context.navigate(leaveTo)),
      ),
  });
}

// Saves a smart collection: a new one (ID null) or the one with ID; a new one opens.
export function saveSmartCollection(
  context: ActionContext,
  id: string | null,
  draft: Omit<SavedSearch, "id">,
): Promise<void> {
  const sent = {
    ...draft,
    name: draft.name.trim(),
    rules: draft.rules.map(trimmedRule),
  };
  if (id !== null) {
    return context.api
      .change("PUT", `/api/saved-searches/${encodeURIComponent(id)}`, sent)
      .then(done);
  }
  return context.api
    .call(SavedSearchSchema, "POST", "/api/saved-searches", sent)
    .then((saved) => context.navigate(organizationPath("saved", saved.id)));
}

export function updatePreferences(context: ActionContext, update: Partial<Preferences>): void {
  run(context, context.api.change("PATCH", "/api/preferences", update));
}

export function organizationActions(
  context: ActionContext,
  chosen: string[],
  smart: Pick<OrganizationActions, "newSmartCollection" | "editSmartCollection">,
): OrganizationActions {
  const collectionPath = (collection: Collection) =>
    `/api/collections/${encodeURIComponent(collection.id)}`;
  const updateCollection = (collection: Collection, update: CollectionUpdate) =>
    context.api.change("PATCH", collectionPath(collection), update).then(done);
  return {
    newCollection: () => createCollection(context),
    updateCollection: (collection, update) => run(context, updateCollection(collection, update)),
    editDescription: (collection) =>
      context.askName({
        title: `Description of “${collection.name}”`,
        label: "Description",
        submitLabel: "Save",
        initialName: collection.description,
        allowEmpty: true,
        onSubmit: (description) => updateCollection(collection, { description }),
      }),
    newTopic: () =>
      context.askName({
        title: `New topic for ${chosen.length} PDFs`,
        label: "Topic",
        submitLabel: "Add",
        initialName: "",
        onSubmit: (name) => changeTags(context, chosen, [topicTag(name)], []).then(done),
      }),
    bulkTag: bulkActions(context, chosen).tag,
    ...smart,
    newSubcollection: (parent) => createCollection(context, parent.id),
    renameCollection: (collection) =>
      context.askName({
        title: "Rename collection",
        label: "Name",
        submitLabel: "Rename",
        initialName: collection.name,
        onSubmit: (name) => updateCollection(collection, { name }),
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
        collectionPath(collection),
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

// Closes the item's reader tab once its annotations are saved, so the send carries them, then
// sends.
export function sendToZotero(
  context: ActionContext,
  key: string,
  onAttempt: (attempt: SendAttempt | null) => void,
): void {
  onAttempt({ kind: "sending" });
  context
    .closeReader(key)
    .then(() => context.api.call(SendResponseSchema, "POST", `${itemPath(key)}/zotero`))
    .then(
      () => onAttempt(null),
      (error: Error) => {
        const refused = error instanceof BucketRequestError && error.kind === "already_sent";
        onAttempt({
          kind: refused ? "refused" : "failed",
          message: error.message,
        });
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
      context.api.refresh();
      onAttempt({ kind: "finished", outcome });
    },
    (error: Error) => onAttempt({ kind: "error", message: error.message }),
  );
}
