// The reader: one EmbedPDF viewer (PDFium compiled to WebAssembly) per window, whose document
// manager holds every PDF open in it. Each PDF's document id is its item key. The manager owns
// opening, activating and closing a PDF, and EmbedPDF keeps each open PDF's scroll position,
// zoom, tools and annotation state; the bucket keeps each one's storage (documentStorage.ts),
// the PDFs put to sleep (documents.ts), and whether the reader is shown at all. The library's
// tabs (tabs.tsx) show what the manager holds; the `/read/<key>` page (main.tsx) opens one PDF in
// its own viewer.
//
// The viewer's one toolbar also holds the reader's buttons (commands.ts): Library (only on the
// `/read/<key>` page), back and forward, night mode and a button that copies the captured PDF
// link. The save state of the PDF shown shows over its corner.

import { PDFViewer, type PDFViewerRef, type PluginRegistry } from "@embedpdf/react-pdf-viewer";
import { useCallback, useMemo, useRef, useState } from "react";
import { useReaderCommands } from "./commands";
import type { DocumentStorage } from "./documentStorage";
import { useControl, useDocuments, useReadingInput } from "./documents";
import {
  useAnnotationDelete,
  usePen,
  useSecondaryPress,
  useStylusModeReport,
} from "./pointerInput";
import { usePositions } from "./positions";
import {
  type Capabilities,
  newHost,
  type ReaderControl,
  type ReaderProjection,
  type TabEntry,
} from "./readerHost";
import {
  connectViewer,
  useSearchKeys,
  useViewerTheme,
  VIEWER_DISABLED,
  viewerConfig,
} from "./viewer";

type ReaderProps = {
  // Whether the reader is the workspace shown (the library's tabs hide it behind the Library).
  shown: boolean;
  inTab: boolean;
  onControl: (control: ReaderControl) => void;
  onProjection?: (projection: ReaderProjection) => void;
  // Each page the PDF shown shows.
  onPage?: (key: string, page: number) => void;
};

export function Reader({ shown, inTab, onControl, onProjection, onPage }: ReaderProps) {
  const viewerRef = useRef<PDFViewerRef>(null);
  const viewerRoot = useCallback(() => {
    const root = viewerRef.current?.container?.shadowRoot;
    if (root === null || root === undefined) {
      throw new Error("the reader's viewer has no shadow root");
    }
    return root;
  }, []);
  const [nightMode, setNightMode] = useState(false);
  // Each change of what the reader draws over the viewer (the PDF shown, its status, a conflict).
  const [, setDrawn] = useState(0);

  const shownRef = useRef(shown);
  shownRef.current = shown;
  const callbacks = useRef({ onProjection, onPage });
  callbacks.current = { onProjection, onPage };

  const host = useRef(newHost()).current;

  const caps = useCallback((): Capabilities => {
    if (host.caps === null) {
      throw new Error("the reader's viewer is not ready");
    }
    return host.caps;
  }, [host]);

  const isShown = useCallback(
    (key: string) =>
      shownRef.current &&
      document.visibilityState === "visible" &&
      host.caps?.documents.getActiveDocumentId() === key,
    [host],
  );

  const storageOf = useCallback(
    (key: string): DocumentStorage | null => {
      const held = host.held.get(key);
      return held?.status === "open" ? held.storage : null;
    },
    [host],
  );

  // The PDF the viewer shows; the viewer shows none before it is ready.
  const activeDocumentId = useCallback(
    (): string | null => (host.caps === null ? null : host.caps.documents.getActiveDocumentId()),
    [host],
  );

  const projection = useCallback((): ReaderProjection => {
    // Before the viewer is ready it holds no PDF; the reader's own entries are all there is.
    const order = host.caps === null ? [] : host.caps.documents.getDocumentOrder();
    const awake = [
      ...order.filter((key) => host.held.has(key)),
      ...[...host.held.keys()].filter((key) => !order.includes(key)),
    ];
    const tabs: TabEntry[] = awake.map((key) => ({
      key,
      title: host.titles.get(key) ?? key,
      asleep: false,
    }));
    const asleep = [...host.bookmarks.entries()].sort(([, a], [, b]) => a.index - b.index);
    for (const [key, bookmark] of asleep) {
      tabs.splice(Math.min(bookmark.index, tabs.length), 0, {
        key,
        title: bookmark.title,
        asleep: true,
      });
    }
    return { tabs, active: host.focus };
  }, [host]);

  const changed = useCallback(() => {
    setDrawn((previous) => previous + 1);
    callbacks.current.onProjection?.(projection());
  }, [projection]);

  const { positionOf, placeOf, restore, restoreOnceSized, scrollToStart } = usePositions(
    host,
    caps,
  );

  // EmbedPDF answers its keyboard shortcuts on the whole document (plugin-commands' keyboard
  // utility), for the active PDF, so while the Library is shown the reader disables every
  // category that holds a shortcut command, and the keys reach the library; with no active PDF no
  // shortcut runs, and each activation scopes them again. Setting the disabled categories is a
  // change of EmbedPDF's store, on which EmbedPDF resolves its commands again, so the toolbar's
  // reader buttons also show the reader's own state (Back, Forward, Night mode) once this runs.
  const scopeShortcuts = useCallback(() => {
    const documentId = activeDocumentId();
    if (host.caps === null || documentId === null) {
      return;
    }
    const commands = host.caps.commands;
    if (shownRef.current) {
      commands.setDisabledCategories(VIEWER_DISABLED);
      return;
    }
    const categories = [...commands.getAllShortcuts().values()].flatMap((id) => {
      const found = commands.resolve(id, documentId).categories;
      if (found === undefined || found.length === 0) {
        throw new Error(`EmbedPDF's shortcut command ${id} has no category to disable`);
      }
      return found;
    });
    commands.setDisabledCategories([...VIEWER_DISABLED, ...categories]);
  }, [host, activeDocumentId]);

  const documentContext = useMemo(
    () => ({ host, caps, changed, projection, storageOf, placeOf, setNightMode }),
    [host, caps, changed, projection, storageOf, placeOf],
  );
  const documents = useDocuments(documentContext);
  useControl(onControl, host, changed, documents);

  const commandsRef = useReaderCommands({
    host,
    storageOf,
    positionOf,
    restore,
    scopeShortcuts,
    setNightMode,
  });

  const onReady = (registry: PluginRegistry) =>
    connectViewer(registry, {
      host,
      viewerRef,
      viewerRoot,
      shownRef,
      onPage: () => callbacks.current.onPage,
      commandsRef,
      inTab,
      scopeShortcuts,
      restoreOnceSized,
      scrollToStart,
      storageOf,
      positionOf,
      isShown,
      changed,
      sleepDrowsy: documents.sleepDrowsy,
    });

  // The PDF shown: its storage while it is open.
  const activeStorage = useCallback((): DocumentStorage | null => {
    const key = activeDocumentId();
    return key === null ? null : storageOf(key);
  }, [storageOf, activeDocumentId]);

  const readingInput = useReadingInput(shown, activeStorage, isShown, scopeShortcuts);
  useSearchKeys(caps, viewerRoot);
  useSecondaryPress(viewerRef, host);
  useAnnotationDelete(shown, host);
  useStylusModeReport(shown, host);
  usePen(viewerRef, host);
  useViewerTheme(viewerRef, viewerRoot, nightMode);

  const config = useMemo(viewerConfig, []);

  const focus = host.focus;
  const focused = focus === null ? undefined : host.held.get(focus);
  const storage = focused?.status === "open" ? focused.storage : null;

  return (
    <div
      className="relative flex h-full flex-col bg-surface text-ink"
      data-reader-key={focus ?? undefined}
      data-night-mode={nightMode}
      onPointerDown={readingInput}
      onPointerMove={readingInput}
      onWheel={readingInput}
    >
      {storage?.conflict === true && focus !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-[0.8125rem] text-danger"
        >
          <span>
            This PDF was saved elsewhere after this reader opened it. The reader shows your copy.
          </span>
          <button
            type="button"
            onClick={() => {
              storage
                .keepMine()
                .catch((error: Error) =>
                  storage.show({ text: `Not saved: ${error.message}`, failed: true }),
                );
            }}
            className="h-7 rounded-md border border-line px-2.5 text-ink hover:bg-surface"
          >
            Save my copy over it
          </button>
          <button
            type="button"
            onClick={() => documents.reload(focus)}
            className="h-7 rounded-md border border-line px-2.5 text-ink hover:bg-surface"
          >
            Discard my copy
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <PDFViewer
          ref={viewerRef}
          config={config}
          onReady={onReady}
          className="reader-viewer absolute inset-0"
        />
        {/* A PDF still loading, or one that could not be opened, covers the viewer. */}
        {focused !== undefined && focused.status !== "open" && (
          <div className="absolute inset-0 bg-surface">
            {focused.status === "failed" && (
              <p role="alert" className="m-4 text-sm text-danger">
                The PDF could not be opened: {focused.message}
              </p>
            )}
          </div>
        )}
      </div>
      {/* The save state and the reader's failures, over the PDF's bottom left corner. */}
      <span
        role="status"
        data-failed={storage?.status?.failed}
        className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-panel/95 px-2.5 py-1 text-xs text-muted shadow empty:hidden data-[failed=true]:text-danger"
      >
        {storage?.status?.text}
      </span>
    </div>
  );
}
