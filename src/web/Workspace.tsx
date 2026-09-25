// The library window once the library has loaded: the sidebar, the screen the address names,
// the details of the selected PDF, the status bar, and the dialogs and palettes over them.
// Workspace holds the window's state; the panels below it draw it.
import type { Table } from "@tanstack/react-table";
import { AlertTriangle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { AdvancedSearchSettings, BucketItem, LibraryPayload } from "../contract/library";
import type { ActionFailure } from "./actionFailure";
import { type ColumnLayout, type LibraryLayout, writeLibraryLayout } from "./columnModel";
import { createAppCommands } from "./commands";
import AdvancedSearchModal from "./components/AdvancedSearchModal";
import CommandPaletteHost from "./components/CommandPaletteHost";
import ConfirmDialog, { type ConfirmRequest } from "./components/ConfirmDialog";
import EmptyTable from "./components/EmptyTable";
import InspectorPanel from "./components/InspectorPanel";
import ItemContextMenu from "./components/ItemContextMenu";
import LibraryBar from "./components/LibraryBar";
import LibraryGrid from "./components/LibraryGrid";
import LibraryTable from "./components/LibraryTable";
import MissingList from "./components/MissingList";
import NameDialog, { type NameRequest } from "./components/NameDialog";
import SelectionBar from "./components/SelectionBar";
import Sidebar from "./components/Sidebar";
import SmartCollectionDialog, {
  type SmartCollectionDraft,
} from "./components/SmartCollectionDialog";
import StatusBar from "./components/StatusBar";
import Toast, { type ToastMessage } from "./components/Toast";
import TopBar from "./components/TopBar";
import { chooseFolder, openInBrowser, showInFolder } from "./desktop";
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
  rebuildAllLost,
  rebuildLost,
  run,
  type SendAttempt,
  saveSearch,
  saveSmartCollection,
  sendToZotero,
  sourceActions,
  updatePreferences,
} from "./libraryActions";
import { type LibraryView, relatedItems, viewExists, visibleItems } from "./librarySelectors";
import { useReaderTabs } from "./readerTabs";
import { entryView, readerPath, type Screen } from "./routes";
import OrganizationScreen from "./screens/OrganizationScreen";
import SettingsScreen from "./screens/SettingsScreen";
import TimelineScreen from "./screens/TimelineScreen";
import { defaultSearchSettings } from "./search";
import { firstRule } from "./smartRules";
import type { StatusRead } from "./useBucketStatus";
import { useExtractionPlugins } from "./useExtractionPlugins";
import { useKeyedAttempts } from "./useKeyedAttempts";
import type { LibraryApi } from "./useLibraryApi";
import { useLibraryShortcuts } from "./useLibraryShortcuts";
import { resetColumnLayout, useLibraryTable } from "./useLibraryTable";

// The view whose items the table shows on this screen, or null when the screen has no table (or
// names a collection or saved search that no longer exists).
function tableView(payload: LibraryPayload, screen: Screen): LibraryView | null {
  if (screen.kind === "library") {
    return screen.view;
  }
  if (screen.kind === "organization" && screen.entry !== null) {
    const view = entryView(screen.tab, screen.entry);
    return viewExists(payload, view) ? view : null;
  }
  return null;
}

// The smart collection being edited: a new one (id null) or a saved search.
type SmartEditor = {
  key: number;
  id: string | null;
  title: string;
  initial: SmartCollectionDraft;
};

// A read of the library after the first one failed: the window keeps what it shows and says so.
function StaleNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p
      role="alert"
      className="flex items-center gap-2 border-b border-line bg-danger-soft px-5 py-2 text-sm text-danger"
    >
      <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        The library shown may be out of date; reading it again failed: {message}
      </span>
      <button type="button" onClick={onRetry} className="font-medium hover:underline">
        Read again
      </button>
    </p>
  );
}

// Files in the library folder the store cannot read as bucket PDFs: every other item is listed,
// and these are named with the reason.
function UnreadableNotice({ files }: { files: LibraryPayload["unreadable"] }) {
  return (
    <section
      role="alert"
      className="border-b border-line bg-danger-soft px-5 py-2 text-sm text-danger"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
        {files.length === 1 ? "A file" : `${files.length} files`} in the library folder cannot be
        read
      </p>
      <ul className="mt-1 space-y-0.5 pl-6">
        {files.map((file) => (
          <li key={file.file} className="break-words">
            <span className="font-mono text-xs">{file.file}</span>: {file.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

type LibraryScreenProps = {
  payload: LibraryPayload;
  screen: Extract<Screen, { kind: "library" }>;
  navigate: (path: string) => void;
  table: Table<BucketItem>;
  layout: LibraryLayout;
  onLayout: (layout: LibraryLayout) => void;
  selectionBar: ReactNode;
  tableElement: ReactNode;
  gridElement: ReactNode;
  rebuilding: ReadonlySet<string>;
  onRebuild: (key: string) => void;
  onRebuildAll: () => void;
};

function LibraryScreen(props: LibraryScreenProps) {
  const { payload, screen } = props;
  return (
    <>
      <LibraryBar
        payload={payload}
        view={screen.view}
        navigate={props.navigate}
        table={props.table}
        layout={props.layout}
        onLayout={props.onLayout}
      />
      {screen.view.kind === "missing" ? (
        <MissingList
          missing={payload.missing}
          rebuilding={props.rebuilding}
          onRebuild={props.onRebuild}
          onRebuildAll={props.onRebuildAll}
        />
      ) : (
        <>
          {props.selectionBar}
          {props.layout === "grid" ? props.gridElement : props.tableElement}
        </>
      )}
    </>
  );
}

type WorkspaceProps = {
  payload: LibraryPayload;
  readFailure: string | null;
  read: StatusRead;
  screen: Screen;
  api: LibraryApi;
  initialColumns: ColumnLayout;
  initialLayout: LibraryLayout;
};

export default function Workspace({
  payload,
  readFailure,
  read,
  screen,
  api,
  initialColumns,
  initialLayout,
}: WorkspaceProps) {
  const [, navigate] = useLocation();
  // index.css resolves every colour from the root's data-theme.
  const { theme } = payload.preferences;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [search, setSearch] = useState<AdvancedSearchSettings>(defaultSearchSettings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Each dialog opened is a new one: its fields start from its request, not from the last dialog.
  const dialogsOpened = useRef(0);
  const [nameRequest, setNameRequest] = useState<{ key: number; request: NameRequest } | null>(
    null,
  );
  const [smartEditor, setSmartEditor] = useState<SmartEditor | null>(null);
  const openSmartEditor = (editor: Omit<SmartEditor, "key">) => {
    dialogsOpened.current += 1;
    setSmartEditor({ key: dialogsOpened.current, ...editor });
  };
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [sendAttempts, setSendAttempt] = useKeyedAttempts<SendAttempt>();
  const [extractionAttempts, setExtractionAttempt] = useKeyedAttempts<ExtractionAttempt>();
  const [noteDrafts, setNoteDraft] = useKeyedAttempts<string>();
  // An item with no draft stored has an empty one: an emptied draft is removed.
  const noteDraftOf = (key: string): string => {
    const text = noteDrafts.get(key);
    return text === undefined ? "" : text;
  };
  // Keys whose sources are being verified, and lost PDFs being rebuilt.
  const [verifying, setVerifying] = useKeyedAttempts<true>();
  const [rebuilding, setRebuilding] = useKeyedAttempts<true>();
  const [layout, setLayout] = useState<LibraryLayout>(initialLayout);
  const plugins = useExtractionPlugins();
  const searchField = useRef<HTMLInputElement>(null);
  const tabs = useReaderTabs();

  const fail = useCallback((failure: ActionFailure) => setToast({ kind: "failure", failure }), []);
  const context: ActionContext = useMemo(
    () => ({
      api,
      closeReader: tabs.closeReader,
      navigate,
      askName: (request) => {
        dialogsOpened.current += 1;
        setNameRequest({ key: dialogsOpened.current, request });
      },
      confirm: setConfirmRequest,
      fail,
      report: (message) => setToast({ kind: "shortfall", message }),
      notify: (message) => setToast({ kind: "notice", message }),
    }),
    [api, tabs.closeReader, navigate, fail],
  );

  const view = useMemo(() => tableView(payload, screen), [payload, screen]);
  const items = useMemo(
    () => (view === null ? [] : visibleItems(payload, view, search)),
    [payload, view, search],
  );
  const table = useLibraryTable(items, initialColumns);
  const selected: BucketItem | undefined = payload.items.find((item) => item.id === selectedId);
  const collectionNames = new Map(
    payload.collections.map((collection) => [collection.id, collection.name]),
  );
  const knownTags = [...new Set(payload.items.flatMap((item) => item.tags))].sort();

  // Every key the window acts on comes from this payload's items.
  const itemById = (key: string) => {
    const item = payload.items.find((candidate) => candidate.id === key);
    if (item === undefined) {
      throw new Error(`the library holds no item ${key}`);
    }
    return item;
  };
  const openReader = (key: string) => tabs.openReader(key, itemById(key).title);
  const readerHref = (key: string) => new URL(readerPath(key), window.location.origin).href;
  const reveal = showInFolder();
  const deselect = () => setSelectedId(null);
  // Runs an action outside the page; a failure shows as a toast.
  const attempt = (action: Promise<void>): void => run(context, action);
  const send = (key: string) =>
    sendToZotero(context, key, (sending) => setSendAttempt(key, sending));
  const extract = (key: string, pluginId: string) =>
    extractWith(context, key, pluginId, (running) => setExtractionAttempt(key, running));
  const rebuild = (key: string) => {
    setRebuilding(key, true);
    rebuildLost(context, key, () => setRebuilding(key, null));
  };
  const rebuildAll = () => {
    const keys = payload.missing.map((lost) => lost.key);
    for (const key of keys) {
      setRebuilding(key, true);
    }
    rebuildAllLost(context, () => {
      for (const key of keys) {
        setRebuilding(key, null);
      }
    });
  };
  const newCollection = () => createCollection(context);
  const saveCurrentSearch = () =>
    saveSearch(context, search, () => setSearch(defaultSearchSettings()));
  const chooseLayout = (next: LibraryLayout) => {
    writeLibraryLayout(next);
    setLayout(next);
  };

  useLibraryShortcuts({
    enabled: tabs.libraryShown,
    searchField,
    onOpenSelected: selected === undefined ? null : () => openReader(selected.id),
    onDeleteSelected:
      selected === undefined ? null : () => itemMenuActions(context, selected, deselect).delete(),
  });

  const rowMenu = (key: string) => {
    const item = itemById(key);
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
    reloadLibrary: api.refresh,
    verifyAllSources: () => attempt(api.change("POST", "/api/verify").then(() => undefined)),
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
  const searchable = screen.kind === "library" || screen.kind === "organization";

  return (
    <div className="flex h-full flex-col">
      {readFailure !== null && <StaleNotice message={readFailure} onRetry={api.refresh} />}
      {payload.unreadable.length > 0 && <UnreadableNotice files={payload.unreadable} />}
      <div className="flex min-h-0 flex-1">
        <Sidebar pdfCount={payload.items.length} onNewCollection={newCollection} />
        <main className="flex min-w-0 flex-1 flex-col bg-panel">
          {searchable && (
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
            <LibraryScreen
              payload={payload}
              screen={screen}
              navigate={navigate}
              table={table}
              layout={layout}
              onLayout={chooseLayout}
              selectionBar={selectionBar}
              tableElement={tableElement}
              gridElement={gridElement}
              rebuilding={new Set(rebuilding.keys())}
              onRebuild={rebuild}
              onRebuildAll={rebuildAll}
            />
          )}
          {screen.kind === "organization" && (
            <OrganizationScreen
              payload={payload}
              tab={screen.tab}
              entry={screen.entry}
              actions={organizationActions(context, selectedKeys, {
                newSmartCollection: () =>
                  openSmartEditor({
                    id: null,
                    title: "New smart collection",
                    initial: { name: "", match: "all", rules: [firstRule(payload)] },
                  }),
                editSmartCollection: ({ id, ...draft }) =>
                  openSmartEditor({ id, title: `Edit “${draft.name}”`, initial: draft }),
              })}
              chosen={selectedKeys.length}
              table={
                <>
                  {selectionBar}
                  {tableElement}
                </>
              }
            />
          )}
          {screen.kind === "timeline" && (
            <TimelineScreen
              stored={new Set(payload.items.map((item) => item.id))}
              onFailure={fail}
            />
          )}
          {screen.kind === "settings" && (
            <SettingsScreen
              read={read}
              onFailure={fail}
              preferences={payload.preferences}
              onPreferences={(update) => updatePreferences(context, update)}
            />
          )}
        </main>
        {selected !== undefined && searchable && (
          <div className="w-[22rem] shrink-0 max-xl:absolute max-xl:top-0 max-xl:bottom-6 max-xl:right-0 max-xl:z-30 max-xl:shadow-2xl">
            <InspectorPanel
              key={selected.id}
              item={selected}
              related={relatedItems(payload, selected)}
              onSelectItem={setSelectedId}
              collections={payload.collections}
              knownTags={knownTags}
              filing={filingActions(context, selected)}
              noteDraft={{
                text: noteDraftOf(selected.id),
                onChange: (text) => setNoteDraft(selected.id, text === "" ? null : text),
              }}
              sources={{
                ...sourceActions(context, selected, (on) =>
                  setVerifying(selected.id, on ? true : null),
                ),
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
              onClose={deselect}
            />
          </div>
        )}
      </div>
      <StatusBar payload={payload} read={read} />

      <CommandPaletteHost items={payload.items} commands={commands} onSelectItem={setSelectedId} />
      <AdvancedSearchModal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        settings={search}
        onChange={setSearch}
        items={view === null ? payload.items : visibleItems(payload, view, defaultSearchSettings())}
      />
      {nameRequest !== null && (
        <NameDialog
          key={nameRequest.key}
          request={nameRequest.request}
          onClose={() => setNameRequest((shown) => (shown === nameRequest ? null : shown))}
        />
      )}
      {smartEditor !== null && (
        <SmartCollectionDialog
          key={smartEditor.key}
          payload={payload}
          title={smartEditor.title}
          initial={smartEditor.initial}
          onSave={(draft) => saveSmartCollection(context, smartEditor.id, draft)}
          onClose={() => setSmartEditor((shown) => (shown === smartEditor ? null : shown))}
        />
      )}
      {confirmRequest !== null && (
        <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />
      )}
      {toast !== null && <Toast toast={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
