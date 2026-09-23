import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Redirect, useLocation } from "wouter";
import {
  type AdvancedSearchSettings,
  type BucketItem,
  CollectionSchema,
  type LibraryPayload,
  LibraryPayloadSchema,
  SavedSearchSchema,
} from "../server/libraryContract";
import {
  type ColumnLayout,
  defaultColumnLayout,
  readColumnLayout,
  writeColumnLayout,
} from "./columnModel";
import { createAppCommands } from "./commands";
import AdvancedSearchModal from "./components/AdvancedSearchModal";
import CommandPaletteHost, { type CommandPaletteHostHandle } from "./components/CommandPaletteHost";
import ConfirmDialog, { type ConfirmRequest } from "./components/ConfirmDialog";
import InspectorPanel, { type ItemFilingActions } from "./components/InspectorPanel";
import LibraryTable from "./components/LibraryTable";
import NameDialog, { type NameRequest } from "./components/NameDialog";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TopBar from "./components/TopBar";
import { type LibraryView, reconcileView, viewName, visibleItems } from "./librarySelectors";
import { entryView, organizationPath, type Screen, screenAt } from "./routes";
import OrganizationScreen, { type OrganizationActions } from "./screens/OrganizationScreen";
import SettingsScreen from "./screens/SettingsScreen";
import { defaultSearchSettings } from "./search";
import { type StatusRead, useBucketStatus } from "./useBucketStatus";
import { type Mutate, useLibraryApi } from "./useLibraryApi";
import { resetColumnLayout, useLibraryTable } from "./useLibraryTable";

function readerUrl(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

function itemPath(key: string): string {
  return `/api/items/${encodeURIComponent(key)}`;
}

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center bg-surface p-6">{children}</div>;
}

// The view whose items the table shows on this screen, or null when the screen has no table.
function tableView(payload: LibraryPayload, screen: Screen): LibraryView | null {
  if (screen.kind === "library") {
    return screen.view;
  }
  if (screen.kind === "organization" && screen.entry !== null) {
    return reconcileView(payload, entryView(screen.tab, screen.entry));
  }
  return null;
}

type WorkspaceProps = {
  payload: LibraryPayload;
  read: StatusRead;
  screen: Screen;
  mutate: Mutate;
  reload: () => void;
  initialLayout: ColumnLayout;
};

function Workspace({ payload, read, screen, mutate, reload, initialLayout }: WorkspaceProps) {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState<AdvancedSearchSettings>(defaultSearchSettings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const palette = useRef<CommandPaletteHostHandle>(null);

  const view = useMemo(() => tableView(payload, screen), [payload, screen]);
  const items = useMemo(
    () => (view === null ? [] : visibleItems(payload, view, search)),
    [payload, view, search],
  );
  const table = useLibraryTable(items, initialLayout);
  const selected: BucketItem | undefined = payload.items.find((item) => item.id === selectedId);
  const collectionNames = new Map(
    payload.collections.map((collection) => [collection.id, collection.name]),
  );
  const knownTags = [...new Set(payload.items.flatMap((item) => item.tags))].sort();

  // A failed mutation leaves the library as the server holds it and says why.
  const run = <T,>(action: Promise<T>) => {
    action.then(
      () => undefined,
      (error: Error) => setToast(error.message),
    );
  };

  const filingFor = (item: BucketItem): ItemFilingActions => ({
    setTags: (tags) =>
      run(mutate(LibraryPayloadSchema, "PUT", `${itemPath(item.id)}/tags`, { tags })),
    setCollections: (collections) =>
      run(mutate(LibraryPayloadSchema, "PUT", `${itemPath(item.id)}/collections`, { collections })),
    addNote: (note) =>
      run(mutate(LibraryPayloadSchema, "POST", `${itemPath(item.id)}/notes`, { note })),
    deleteNote: (noteId) =>
      run(
        mutate(
          LibraryPayloadSchema,
          "DELETE",
          `${itemPath(item.id)}/notes/${encodeURIComponent(noteId)}`,
        ),
      ),
  });

  const createCollection = (parentId?: string) =>
    setNameRequest({
      title: parentId === undefined ? "New collection" : "New subcollection",
      label: "Name",
      submitLabel: "Create",
      initialName: "",
      onSubmit: (name) =>
        run(
          mutate(CollectionSchema, "POST", "/api/collections", { name, parentId }).then(
            (collection) => navigate(organizationPath("collections", collection.id)),
          ),
        ),
    });

  const saveSearch = () =>
    setNameRequest({
      title: "Save search",
      label: "Name",
      submitLabel: "Save",
      initialName: search.query.trim(),
      onSubmit: (name) =>
        run(
          mutate(SavedSearchSchema, "POST", "/api/saved-searches", { name, search }).then(
            (saved) => {
              setSearch(defaultSearchSettings());
              navigate(organizationPath("saved", saved.id));
            },
          ),
        ),
    });

  const organizationActions: OrganizationActions = {
    newSubcollection: (parent) => createCollection(parent.id),
    renameCollection: (collection) =>
      setNameRequest({
        title: "Rename collection",
        label: "Name",
        submitLabel: "Rename",
        initialName: collection.name,
        onSubmit: (name) =>
          run(
            mutate(
              LibraryPayloadSchema,
              "PATCH",
              `/api/collections/${encodeURIComponent(collection.id)}`,
              { name },
            ),
          ),
      }),
    deleteCollection: (collection) =>
      setConfirmRequest({
        title: `Delete “${collection.name}”?`,
        description:
          "The collection and its subcollections are deleted. The PDFs in them stay in the library with their tags and notes.",
        confirmLabel: "Delete collection",
        onConfirm: () =>
          run(
            mutate(
              LibraryPayloadSchema,
              "DELETE",
              `/api/collections/${encodeURIComponent(collection.id)}`,
            ).then(() => navigate(organizationPath("collections"))),
          ),
      }),
    deleteSavedSearch: (saved) =>
      setConfirmRequest({
        title: `Delete “${saved.name}”?`,
        description: "The stored search is deleted. No PDF changes.",
        confirmLabel: "Delete search",
        onConfirm: () =>
          run(
            mutate(
              LibraryPayloadSchema,
              "DELETE",
              `/api/saved-searches/${encodeURIComponent(saved.id)}`,
            ).then(() => navigate(organizationPath("saved"))),
          ),
      }),
  };

  const openReader = (key: string) => window.location.assign(readerUrl(key));

  const commands = createAppCommands({
    navigate,
    newCollection: () => createCollection(),
    saveSearch,
    openSelectedInReader: selected === undefined ? null : () => openReader(selected.id),
    reloadLibrary: reload,
    showAllColumns: () => table.toggleAllColumnsVisible(true),
    resetColumns: () => resetColumnLayout(table),
  });

  const tableElement = (
    <LibraryTable
      table={table}
      collectionNames={collectionNames}
      selectedItemId={selectedId}
      onSelectItem={setSelectedId}
      onOpenItem={openReader}
      empty={
        payload.items.length === 0 ? (
          <>
            <p className="text-base font-semibold">No PDFs in the bucket yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Open a PDF link in Chrome or Firefox with the capture extension installed; the PDF is
              stored here with where it came from.
            </p>
          </>
        ) : (
          <>
            <p className="text-base font-semibold">No PDFs match</p>
            <button
              type="button"
              onClick={() => setSearch(defaultSearchSettings())}
              className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface"
            >
              Clear the search
            </button>
          </>
        )
      }
    />
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar payload={payload} read={read} />
        <main className="flex min-w-0 flex-1 flex-col bg-white">
          {screen.kind !== "settings" && (
            <TopBar
              search={search}
              onChangeSearch={setSearch}
              onOpenFilters={() => setFiltersOpen(true)}
              onOpenPalette={() => palette.current?.open("items")}
              onSaveSearch={saveSearch}
              onNewCollection={() => createCollection()}
            />
          )}
          {screen.kind === "library" && (
            <>
              <div className="flex items-baseline gap-3 px-5 pt-4 pb-3">
                <h1 className="text-lg font-semibold">{viewName(payload, screen.view)}</h1>
                <span className="text-sm text-muted">
                  {items.length.toLocaleString()} {items.length === 1 ? "PDF" : "PDFs"}
                </span>
              </div>
              {tableElement}
            </>
          )}
          {screen.kind === "organization" && (
            <OrganizationScreen
              payload={payload}
              tab={screen.tab}
              entry={view === null || view.kind === "all" ? null : screen.entry}
              actions={organizationActions}
              table={tableElement}
            />
          )}
          {screen.kind === "settings" && <SettingsScreen payload={payload} read={read} />}
        </main>
        {selected !== undefined && screen.kind !== "settings" && (
          <div className="w-[26rem] shrink-0 max-2xl:fixed max-2xl:inset-y-0 max-2xl:right-0 max-2xl:z-30 max-2xl:shadow-2xl">
            <InspectorPanel
              key={selected.id}
              item={selected}
              collections={payload.collections}
              knownTags={knownTags}
              filing={filingFor(selected)}
              onOpenReader={() => openReader(selected.id)}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>
      <StatusBar payload={payload} read={read} />

      <CommandPaletteHost
        ref={palette}
        items={payload.items}
        commands={commands}
        onSelectItem={setSelectedId}
      />
      <AdvancedSearchModal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        settings={search}
        onChange={setSearch}
        items={view === null ? payload.items : visibleItems(payload, view, defaultSearchSettings())}
      />
      {nameRequest !== null && (
        <NameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
      )}
      {confirmRequest !== null && (
        <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />
      )}
      {toast !== null && (
        <div
          role="alert"
          className="fixed right-5 bottom-12 z-50 flex max-w-md items-start gap-2 rounded-lg bg-ink px-4 py-3 text-sm text-white shadow-xl"
        >
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <span className="flex-1">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-white/70 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { state, reload, mutate } = useLibraryApi();
  const read = useBucketStatus();
  const [location] = useLocation();
  const [layoutRead, setLayoutRead] = useState(readColumnLayout);
  const screen = useMemo(() => screenAt(location), [location]);

  if (state.status === "loading") {
    return (
      <FullScreen>
        <p role="status" className="flex items-center gap-3 text-base text-muted">
          <LoaderCircle aria-hidden className="h-5 w-5 animate-spin text-accent" /> Loading the
          library
        </p>
      </FullScreen>
    );
  }

  if (state.status === "failed") {
    return (
      <FullScreen>
        <section
          role="alert"
          className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-lg ring-1 ring-line"
        >
          <h1 className="flex items-center gap-2 text-lg font-semibold text-red-700">
            <AlertTriangle aria-hidden className="h-5 w-5" /> The library could not be loaded
          </h1>
          <p className="mt-3 text-sm break-words text-ink">{state.message}</p>
          {state.detail !== null && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-muted">Store output</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-surface p-4 font-mono text-xs whitespace-pre-wrap text-ink">
                {state.detail}
              </pre>
            </details>
          )}
          <button
            type="button"
            onClick={reload}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            <RefreshCw className="h-4 w-4" /> Reload the library
          </button>
        </section>
      </FullScreen>
    );
  }

  if (layoutRead.status === "invalid") {
    return (
      <FullScreen>
        <section
          role="alert"
          className="w-full max-w-xl rounded-xl bg-white p-6 shadow-lg ring-1 ring-line"
        >
          <h1 className="text-lg font-semibold">
            The saved column layout does not fit this version
          </h1>
          <pre className="mt-3 max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">
            {layoutRead.reason}
          </pre>
          <button
            type="button"
            onClick={() => {
              writeColumnLayout(defaultColumnLayout());
              setLayoutRead(readColumnLayout());
            }}
            className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Reset the column layout
          </button>
        </section>
      </FullScreen>
    );
  }

  if (screen === null) {
    return <Redirect to="/" />;
  }
  return (
    <Workspace
      payload={state.payload}
      read={read}
      screen={screen}
      mutate={mutate}
      reload={reload}
      initialLayout={layoutRead.layout}
    />
  );
}
