import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Redirect, useLocation } from "wouter";
import {
  type AdvancedSearchSettings,
  type BucketItem,
  type LibraryPayload,
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
import LibraryTable from "./components/LibraryTable";
import NameDialog, { type NameRequest } from "./components/NameDialog";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TopBar from "./components/TopBar";
import {
  type ActionContext,
  createCollection,
  filingActions,
  organizationActions,
  removeFromBucket,
  type SendAttempt,
  saveSearch,
  sendToZotero,
} from "./libraryActions";
import { type LibraryView, reconcileView, viewName, visibleItems } from "./librarySelectors";
import { entryView, type Screen, screenAt } from "./routes";
import OrganizationScreen from "./screens/OrganizationScreen";
import SettingsScreen from "./screens/SettingsScreen";
import { defaultSearchSettings } from "./search";
import { type StatusRead, useBucketStatus } from "./useBucketStatus";
import { type Mutate, useLibraryApi } from "./useLibraryApi";
import { resetColumnLayout, useLibraryTable } from "./useLibraryTable";

function readerUrl(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
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
  refresh: () => void;
  initialLayout: ColumnLayout;
};

function Workspace({
  payload,
  read,
  screen,
  mutate,
  reload,
  refresh,
  initialLayout,
}: WorkspaceProps) {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState<AdvancedSearchSettings>(defaultSearchSettings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sendAttempts, setSendAttempts] = useState<ReadonlyMap<string, SendAttempt>>(new Map());
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

  const context: ActionContext = {
    mutate,
    refresh,
    navigate,
    askName: setNameRequest,
    confirm: setConfirmRequest,
    report: setToast,
  };
  const newCollection = () => createCollection(context);
  const saveCurrentSearch = () =>
    saveSearch(context, search, () => setSearch(defaultSearchSettings()));

  const openReader = (key: string) => window.location.assign(readerUrl(key));
  const send = (key: string) =>
    sendToZotero(context, key, (attempt) =>
      setSendAttempts((attempts) => {
        const next = new Map(attempts);
        if (attempt === null) {
          next.delete(key);
        } else {
          next.set(key, attempt);
        }
        return next;
      }),
    );

  const commands = createAppCommands({
    navigate,
    newCollection,
    saveSearch: saveCurrentSearch,
    openSelectedInReader: selected === undefined ? null : () => openReader(selected.id),
    sendSelectedToZotero: selected === undefined ? null : () => send(selected.id),
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
        <EmptyTable
          bucketEmpty={payload.items.length === 0}
          searching={search.query.trim().length > 0}
          onClearSearch={() => setSearch(defaultSearchSettings())}
        />
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
              onSaveSearch={saveCurrentSearch}
              onNewCollection={newCollection}
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
              actions={organizationActions(context)}
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
              filing={filingActions(context, selected.id)}
              send={{
                attempt: sendAttempts.get(selected.id) ?? null,
                onSend: () => send(selected.id),
                onRemove: () => removeFromBucket(context, selected, () => setSelectedId(null)),
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
  const { state, reload, refresh, mutate } = useLibraryApi();
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
      mutate={mutate}
      reload={reload}
      refresh={refresh}
      initialLayout={layoutRead.layout}
    />
  );
}
