import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Redirect, useLocation } from "wouter";
import {
  type AdvancedSearchSettings,
  type BucketItem,
  type LibraryPayload,
  LibraryPayloadSchema,
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
import EmptyTable from "./components/EmptyTable";
import InspectorPanel from "./components/InspectorPanel";
import ItemContextMenu from "./components/ItemContextMenu";
import LibraryBar, { type LibraryLayout } from "./components/LibraryBar";
import LibraryGrid from "./components/LibraryGrid";
import LibraryTable from "./components/LibraryTable";
import MissingList from "./components/MissingList";
import NameDialog, { type NameRequest } from "./components/NameDialog";
import SelectionBar from "./components/SelectionBar";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TopBar from "./components/TopBar";
import { chooseFolder, openInBrowser, showInFolder } from "./desktop";
import { KEYBOARD_SHORTCUTS, matchesShortcut } from "./keyboardShortcuts";
import {
  type ActionContext,
  addFolder,
  bulkActions,
  createCollection,
  type ExtractionAttempt,
  extractWith,
  filingActions,
  importUrl,
  itemMenuActions,
  organizationActions,
  rebuildLost,
  type SendAttempt,
  saveSearch,
  sendToZotero,
  sourceActions,
} from "./libraryActions";
import { type LibraryView, reconcileView, visibleItems } from "./librarySelectors";
import { entryView, type Screen, screenAt } from "./routes";
import OrganizationScreen from "./screens/OrganizationScreen";
import SettingsScreen from "./screens/SettingsScreen";
import { defaultSearchSettings } from "./search";
import { type StatusRead, useBucketStatus } from "./useBucketStatus";
import { useExtractionPlugins } from "./useExtractionPlugins";
import { useKeyedAttempts } from "./useKeyedAttempts";
import { type LibraryApi, useLibraryApi } from "./useLibraryApi";
import { resetColumnLayout, useLibraryTable } from "./useLibraryTable";

function readerUrl(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

// List or grid, kept in this browser for the next visit.
const LAYOUT_STORAGE_KEY = "pdf-bucket:layout";

function useLibraryLayout(): [LibraryLayout, (layout: LibraryLayout) => void] {
  const [layout, setLayout] = useState<LibraryLayout>(() =>
    localStorage.getItem(LAYOUT_STORAGE_KEY) === "grid" ? "grid" : "list",
  );
  const choose = (next: LibraryLayout) => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    setLayout(next);
  };
  return [layout, choose];
}

// A message at the window's corner: why a call failed, or what a call did.
type Toast = { kind: "failure" | "notice"; message: string };

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
  api: LibraryApi;
  initialLayout: ColumnLayout;
};

function Workspace({ payload, read, screen, api, initialLayout }: WorkspaceProps) {
  const { mutate, reload, refresh } = api;
  const [, navigate] = useLocation();
  const [search, setSearch] = useState<AdvancedSearchSettings>(defaultSearchSettings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const report = (message: string) => setToast({ kind: "failure", message });
  const [sendAttempts, setSendAttempt] = useKeyedAttempts<SendAttempt>();
  const [extractionAttempts, setExtractionAttempt] = useKeyedAttempts<ExtractionAttempt>();
  // Keys whose sources are being verified, and lost PDFs being rebuilt.
  const [verifying, setVerifying] = useState<ReadonlySet<string>>(new Set());
  const [rebuilding, setRebuilding] = useState<ReadonlySet<string>>(new Set());
  const [layout, setLayout] = useLibraryLayout();
  const toggleKey =
    (setter: typeof setVerifying, key: string) =>
    (on: boolean): void =>
      setter((previous) => {
        const next = new Set(previous);
        if (on) {
          next.add(key);
        } else {
          next.delete(key);
        }
        return next;
      });
  const rebuild = (key: string) => {
    toggleKey(setRebuilding, key)(true);
    rebuildLost(context, key, () => toggleKey(setRebuilding, key)(false));
  };
  const rebuildAll = () => {
    for (const lost of payload.missing) {
      rebuild(lost.key);
    }
  };
  const plugins = useExtractionPlugins();
  const palette = useRef<CommandPaletteHostHandle>(null);
  const searchField = useRef<HTMLInputElement>(null);

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

  const context: ActionContext = {
    mutate,
    refresh,
    navigate,
    askName: setNameRequest,
    confirm: setConfirmRequest,
    report,
    notify: (message) => setToast({ kind: "notice", message }),
  };
  const newCollection = () => createCollection(context);
  const saveCurrentSearch = () =>
    saveSearch(context, search, () => setSearch(defaultSearchSettings()));

  const openReader = (key: string) => window.location.assign(readerUrl(key));
  const readerHref = (key: string) => new URL(readerUrl(key), window.location.origin).href;
  const reveal = showInFolder();
  const itemById = (key: string) => payload.items.find((item) => item.id === key);
  const deselect = () => setSelectedId(null);
  // Runs an action outside the page; a failure shows as a toast.
  const attempt = (action: Promise<void>): void => {
    action.then(
      () => undefined,
      (error: Error) => report(error.message),
    );
  };

  // Ctrl+F finds in the table; Enter opens and Delete deletes the selected PDF.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, KEYBOARD_SHORTCUTS.focusSearch)) {
        event.preventDefault();
        searchField.current?.focus();
        searchField.current?.select();
        return;
      }
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (
        typing ||
        selected === undefined ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null
      ) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openReader(selected.id);
      }
      if (event.key === "Delete") {
        event.preventDefault();
        itemMenuActions(context, selected, deselect).delete();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const rowMenu = (key: string) => {
    const item = itemById(key);
    if (item === undefined) {
      return null;
    }
    const actions = itemMenuActions(context, item, deselect);
    return (
      <ItemContextMenu
        item={item}
        collections={payload.collections}
        commands={{
          open: () => openReader(key),
          openInBrowser: () => attempt(openInBrowser(readerHref(key))),
          retrieveMetadata: actions.retrieveMetadata,
          fileIn: actions.fileIn,
          fileInNewCollection: actions.fileInNewCollection,
          addTag: actions.addTag,
          send: () => send(key),
          copy: (text) => attempt(navigator.clipboard.writeText(text)),
          showInFolder: reveal === null ? null : () => attempt(reveal(item.file.path)),
          delete: actions.delete,
        }}
      />
    );
  };
  const send = (key: string) =>
    sendToZotero(context, key, (attempt) => setSendAttempt(key, attempt));
  const extract = (key: string, pluginId: string) =>
    extractWith(context, key, pluginId, (attempt) => setExtractionAttempt(key, attempt));

  const commands = createAppCommands({
    navigate,
    newCollection,
    saveSearch: saveCurrentSearch,
    openSelectedInReader: selected === undefined ? null : () => openReader(selected.id),
    openSelectedInBrowser:
      selected === undefined ? null : () => attempt(openInBrowser(readerHref(selected.id))),
    showSelectedInFolder:
      selected === undefined || reveal === null ? null : () => attempt(reveal(selected.file.path)),
    sendSelectedToZotero: selected === undefined ? null : () => send(selected.id),
    reloadLibrary: reload,
    verifyAllSources: () =>
      attempt(mutate(LibraryPayloadSchema, "POST", "/api/verify").then(() => undefined)),
    rebuildAllLost: rebuildAll,
    showAllColumns: () => table.toggleAllColumnsVisible(true),
    resetColumns: () => resetColumnLayout(table),
  });

  const empty = (
    <EmptyTable
      bucketEmpty={payload.items.length === 0}
      searching={search.query.trim().length > 0}
      onClearSearch={() => setSearch(defaultSearchSettings())}
    />
  );
  const selectedKeys = table.getSelectedRowModel().rows.map((row) => row.id);
  const bulk = bulkActions(context, selectedKeys);
  const selectionBar = selectedKeys.length > 0 && (
    <SelectionBar
      count={selectedKeys.length}
      collections={payload.collections}
      onTag={bulk.tag}
      onFile={bulk.file}
      onFileInNew={bulk.fileInNew}
      onClear={() => table.resetRowSelection()}
    />
  );
  const tableElement = (
    <LibraryTable
      table={table}
      collectionNames={collectionNames}
      selectedItemId={selectedId}
      onSelectItem={setSelectedId}
      onOpenItem={openReader}
      rowMenu={rowMenu}
      empty={empty}
    />
  );
  const gridElement = (
    <LibraryGrid
      table={table}
      selectedItemId={selectedId}
      onSelectItem={setSelectedId}
      onOpenItem={openReader}
      rowMenu={rowMenu}
      empty={empty}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar pdfCount={payload.items.length} onNewCollection={newCollection} />
        <main className="flex min-w-0 flex-1 flex-col bg-white">
          {screen.kind !== "settings" && (
            <TopBar
              ref={searchField}
              search={search}
              onChangeSearch={setSearch}
              onOpenFilters={() => setFiltersOpen(true)}
              onSaveSearch={saveCurrentSearch}
              onImportUrl={() => importUrl(context, setSelectedId)}
              onAddFolder={() => addFolder(context, chooseFolder())}
            />
          )}
          {screen.kind === "library" && (
            <LibraryBar
              payload={payload}
              view={screen.view}
              navigate={navigate}
              table={table}
              layout={layout}
              onLayout={setLayout}
            />
          )}
          {screen.kind === "library" && screen.view.kind !== "missing" && selectionBar}
          {screen.kind === "library" &&
            screen.view.kind !== "missing" &&
            (layout === "grid" ? gridElement : tableElement)}
          {screen.kind === "library" && screen.view.kind === "missing" && (
            <MissingList
              missing={payload.missing}
              rebuilding={rebuilding}
              onRebuild={rebuild}
              onRebuildAll={rebuildAll}
            />
          )}
          {screen.kind === "organization" && (
            <OrganizationScreen
              payload={payload}
              tab={screen.tab}
              entry={view === null || view.kind === "all" ? null : screen.entry}
              actions={organizationActions(context)}
              table={
                <>
                  {selectionBar}
                  {tableElement}
                </>
              }
            />
          )}
          {screen.kind === "settings" && <SettingsScreen read={read} onError={report} />}
        </main>
        {selected !== undefined && screen.kind !== "settings" && (
          <div className="w-[22rem] shrink-0 max-xl:fixed max-xl:top-0 max-xl:bottom-6 max-xl:right-0 max-xl:z-30 max-xl:shadow-2xl">
            <InspectorPanel
              key={selected.id}
              item={selected}
              collections={payload.collections}
              knownTags={knownTags}
              filing={filingActions(context, selected)}
              sources={{
                ...sourceActions(context, selected, toggleKey(setVerifying, selected.id)),
                verifying: verifying.has(selected.id),
              }}
              send={{
                attempt: sendAttempts.get(selected.id),
                onSend: () => send(selected.id),
              }}
              extraction={{
                plugins,
                attempt: extractionAttempts.get(selected.id),
                onRun: (pluginId) => extract(selected.id, pluginId),
              }}
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
          role={toast.kind === "failure" ? "alert" : "status"}
          className="fixed right-5 bottom-12 z-50 flex max-w-md items-start gap-2 rounded-lg bg-ink px-4 py-3 text-sm text-white shadow-xl"
        >
          {toast.kind === "failure" ? (
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          ) : (
            <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-green-300" />
          )}
          <span className="flex-1">{toast.message}</span>
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
  const { state, ...api } = useLibraryApi();
  const { reload } = api;
  const read = useBucketStatus();
  const [location] = useLocation();
  const [layoutRead, setLayoutRead] = useState(readColumnLayout);
  const screen = useMemo(() => screenAt(location), [location]);

  if (state.status === "loading") {
    return (
      <FullScreen>
        <output className="flex items-center gap-3 text-base text-muted">
          <LoaderCircle aria-hidden className="h-5 w-5 animate-spin text-accent" /> Loading the
          library
        </output>
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
      api={api}
      initialLayout={layoutRead.layout}
    />
  );
}
