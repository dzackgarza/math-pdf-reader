// The reader: one EmbedPDF viewer (PDFium compiled to WebAssembly) per window, whose document
// manager holds every PDF open in it. Each PDF's document id is its item key. The manager owns
// opening, activating and closing a PDF, and EmbedPDF keeps each open PDF's scroll position,
// zoom, tools and annotation state; the bucket keeps each one's storage (documentStorage.ts),
// the PDFs put to sleep, and whether the reader is shown at all. The library's tabs (tabs.tsx)
// show what the manager holds; the `/read/<key>` page (main.tsx) opens one PDF in its own
// viewer.
//
// The viewer's one toolbar also holds the reader's buttons: Library (only on the `/read/<key>`
// page), back and forward, night mode and a button that copies the captured PDF link. The save
// state of the PDF shown shows over its corner.
//
// Sleep: EmbedPDF's document manager has no suspend, so a PDF put to sleep settles its saves, is
// closed, and leaves a bookmark (its title, exact position and place among the tabs); waking it
// opens the stored PDF again at that position and place.

import { expandRect, PdfAnnotationSubtype, rectFromPoints } from "@embedpdf/models";
import pdfiumWasm from "@embedpdf/pdfium/pdfium.wasm?url";
import {
  AnnotationPlugin,
  type Command,
  CommandsPlugin,
  type CustomIconConfig,
  DocumentManagerPlugin,
  ExportPlugin,
  InteractionManagerPlugin,
  LockModeType,
  PDFViewer,
  type PDFViewerConfig,
  type PDFViewerRef,
  type PluginRegistry,
  ScrollPlugin,
  SearchPlugin,
  type ToolbarItem,
  UIPlugin,
  ViewportPlugin,
  ZoomPlugin,
} from "@embedpdf/react-pdf-viewer";
import { ArrowLeft, ArrowRight, type IconNode, Library, Link, Moon } from "lucide";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BucketItem,
  LIBRARY_VIEW_KEY,
  LibraryPayloadSchema,
  type Preferences,
  ThemeSchema,
} from "../../contract/library";
import { request, requestError } from "../useLibraryApi";
import { DocumentStorage, entityTag, type Position } from "./documentStorage";
import { fallbackFonts } from "./fallbackFonts";

// A PDF tab as the tab row draws it.
export type TabEntry = { key: string; title: string; asleep: boolean };

// What the reader holds: its PDFs in tab order, and the one it shows (null: none).
export type ReaderProjection = { tabs: TabEntry[]; active: string | null };

// What the reader offers whoever shows it. Activate shows a PDF the reader holds, waking it when
// it sleeps. Close and sleep settle the PDF first (send its reading session, save every
// annotation) and reject, leaving it open, when it cannot settle; discard closes it without
// saving. settleAll settles every open PDF.
export type ReaderControl = {
  open: (key: string, title: string, page?: number) => void;
  activate: (key: string) => void;
  close: (key: string) => Promise<void>;
  discard: (key: string) => void;
  sleep: (key: string) => Promise<void>;
  retitle: (key: string, title: string) => void;
  settleAll: () => Promise<void>;
};

// How many PDFs stay open in the manager. Past it, the PDFs shown longest ago sleep, which frees
// their PDFium documents, and showing one opens it again where it was. Firefox's tab unloader
// picks the tabs it unloads the same way, by the time each was last shown
// (browser/components/tabbrowser/TabUnloader.sys.mjs).
const AWAKE_READERS = 5;

// What the reader's status says after Copy PDF link, and for how long.
const COPIED = "PDF link copied";
const COPIED_SHOWN_MS = 1500;

// The bucket opens, closes, prints and redacts nothing through the viewer's own controls.
const VIEWER_DISABLED = ["document", "redaction"];

// Night mode draws each page inverted, with hues turned back, so text is light on dark and
// highlights keep their colours. EmbedPDF draws a page in one box with a white background (the
// snippet's renderPage), holding a low-resolution image, a layer of sharp tiles and the
// annotation layers; the box is the one element inverted, since an inverted element inside it
// would turn back.
const NIGHT_PAGES = 'div[style*="transform-origin"][style*="background-color: rgb(255, 255, 255)"]';

// The box EmbedPDF draws a page in, the element a pointer must land on to be drawing (the desktop
// suite's page boxes name the same element). A press on the toolbar or a sidebar is not one.
const PAGE_BOX = 'div[style*="transform-origin"][style*="background-color"]';

// The reader's text-markup highlighter, the tool a stylus always draws with.
const HIGHLIGHT_TOOL = "highlight";

// How far an arrow key scrolls, in CSS pixels, and what share of the viewport a page key does
// (Firefox: toolkit.scrollbox line height, and a page less a tenth).
const LINE_STEP = 40;
const PAGE_SHARE = 0.9;

function plugin<
  T extends
    | ExportPlugin
    | ScrollPlugin
    | AnnotationPlugin
    | CommandsPlugin
    | UIPlugin
    | DocumentManagerPlugin
    | InteractionManagerPlugin
    | SearchPlugin
    | ViewportPlugin
    | ZoomPlugin,
>(registry: PluginRegistry, id: string): ReturnType<T["provides"]> {
  const found = registry.getPlugin<T>(id);
  if (found === null) {
    throw new Error(`the reader has no ${id} plugin`);
  }
  return found.provides() as ReturnType<T["provides"]>;
}

// Escape puts down the tool in hand (a highlighter, a shape) and takes up the default one, which
// selects text, as the toolbar's pointer button does. EmbedPDF binds no key to it.
const DEFAULT_TOOL: Command = {
  id: "bucket:default-tool",
  label: "Default tool",
  shortcuts: ["Escape"],
  categories: ["tools", "pointer"],
  action: ({ registry, documentId }) =>
    plugin<InteractionManagerPlugin>(registry, InteractionManagerPlugin.id)
      .forDocument(documentId)
      .activateDefaultMode(),
};

// The keys a browser scrolls a page with scroll the PDF shown whatever has the focus, as
// EmbedPDF's own shortcuts answer on the whole document: its viewport holds no focus, so before
// a click the browser's own scrolling has no element to move.
function scrollCommand(
  id: string,
  shortcuts: string[],
  to: (metrics: { top: number; height: number; end: number }) => number,
): Command {
  return {
    id: `bucket:scroll-${id}`,
    label: `Scroll ${id}`,
    shortcuts,
    categories: ["navigation", "navigation-scroll"],
    action: ({ registry, documentId }) => {
      const viewport = plugin<ViewportPlugin>(registry, ViewportPlugin.id).forDocument(documentId);
      const metrics = viewport.getMetrics();
      viewport.scrollTo({
        x: metrics.scrollLeft,
        y: to({
          top: metrics.scrollTop,
          height: metrics.clientHeight,
          end: metrics.scrollHeight - metrics.clientHeight,
        }),
        behavior: "instant",
      });
    },
  };
}

const SCROLL_COMMANDS = [
  scrollCommand("down", ["ArrowDown"], ({ top }) => top + LINE_STEP),
  scrollCommand("up", ["ArrowUp"], ({ top }) => top - LINE_STEP),
  scrollCommand("page-down", ["PageDown", "Space"], ({ top, height }) => top + height * PAGE_SHARE),
  scrollCommand("page-up", ["PageUp", "Shift+Space"], ({ top, height }) => top - height * PAGE_SHARE),
  scrollCommand("start", ["Home"], () => 0),
  scrollCommand("end", ["End"], ({ end }) => end),
];

// EmbedPDF's search panel (its sidebar `search-panel`) and the field in it.
const SEARCH_PANEL = "search-panel";
const SEARCH_FIELD = `[data-sidebar-id="${SEARCH_PANEL}"] input[type="text"]`;

// Ctrl+F opens EmbedPDF's search panel and puts the cursor in its field with the query selected,
// as a browser's find bar does. EmbedPDF's own Ctrl+F only toggles the panel and leaves the focus
// where it was; the panel's toolbar button still toggles it.
function findCommand(root: () => ShadowRoot): Command {
  return {
    id: "bucket:find",
    label: "Find in document",
    shortcuts: ["Ctrl+F", "Meta+F"],
    categories: ["panel", "panel-search"],
    action: ({ registry, documentId }) => {
      const ui = plugin<UIPlugin>(registry, UIPlugin.id).forDocument(documentId);
      if (!ui.isSidebarOpen("right", "main", SEARCH_PANEL)) {
        ui.setActiveSidebar("right", "main", SEARCH_PANEL);
      }
      requestAnimationFrame(() => {
        const field = root().querySelector<HTMLInputElement>(SEARCH_FIELD);
        if (field === null) {
          throw new Error("EmbedPDF's search panel has no search field");
        }
        field.focus();
        field.select();
      });
    },
  };
}

// A lucide icon as EmbedPDF's icon registry takes it. Lucide draws paths with strokes of width 2,
// round ends and joins, in the text colour (lucide's default attributes); EmbedPDF draws paths
// only, so an icon with another element is refused.
function embedIcon(node: IconNode): CustomIconConfig {
  return {
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    paths: node.map(([tag, attributes]) => {
      if (tag !== "path" || typeof attributes.d !== "string") {
        throw new Error(`EmbedPDF draws icon paths, not a lucide ${tag}`);
      }
      return { d: attributes.d, stroke: "currentColor" };
    }),
  };
}

const READER_ICONS = {
  "bucket-library": embedIcon(Library),
  "bucket-back": embedIcon(ArrowLeft),
  "bucket-forward": embedIcon(ArrowRight),
  "bucket-night-mode": embedIcon(Moon),
  "bucket-copy-link": embedIcon(Link),
};

// The reader's buttons in EmbedPDF's main toolbar, one command each: Library, Back and Forward
// open its left group, Night mode and Copy PDF link close its right group. The reader in the
// library's tabs has no Library button: the tab row holds the way back.
function commandButton(commandId: string): ToolbarItem {
  return { type: "command-button", id: commandId, commandId, variant: "icon" };
}

function withReaderButtons(items: ToolbarItem[], inTab: boolean): ToolbarItem[] {
  const leading = [
    ...(inTab ? [] : [commandButton("bucket:library")]),
    commandButton("bucket:back"),
    commandButton("bucket:forward"),
  ];
  const trailing = [commandButton("bucket:night-mode"), commandButton("bucket:copy-link")];
  const groups = new Set(items.flatMap((item) => (item.type === "group" ? [item.id] : [])));
  for (const id of ["left-group", "center-group", "right-group"]) {
    if (!groups.has(id)) {
      throw new Error(`EmbedPDF's main toolbar has no ${id}`);
    }
  }
  return items.map((item) => {
    if (item.type !== "group") {
      return item;
    }
    if (item.id === "left-group") {
      return { ...item, items: [...leading, ...item.items] };
    }
    if (item.id === "right-group") {
      return { ...item, items: [...item.items, ...trailing] };
    }
    if (item.id === "center-group") {
      return {
        ...item,
        items: [
          {
            type: "custom",
            id: "bucket-page-controls",
            componentId: "page-controls",
            categories: ["page"],
          },
          {
            type: "divider",
            id: "bucket-page-divider",
            orientation: "vertical",
          },
          ...item.items,
        ],
      };
    }
    return item;
  });
}

type Loaded = {
  item: BucketItem;
  preferences: Preferences;
  // The stored PDF's bytes and their entity tag.
  bytes: ArrayBuffer;
  tag: string;
};

async function load(key: string): Promise<Loaded> {
  const library = await request(LibraryPayloadSchema, "GET", "/api/library");
  const item = library.items.find((candidate) => candidate.id === key);
  if (item === undefined) {
    throw new Error(`the library holds no PDF ${key}`);
  }
  const response = await fetch(`/pdf/${encodeURIComponent(key)}.pdf`);
  if (!response.ok) {
    throw await requestError(response);
  }
  return {
    item,
    preferences: library.preferences,
    bytes: await response.arrayBuffer(),
    tag: entityTag(response),
  };
}

// Where a PDF opens: an exact position (a bookmark), a page, or the page last viewed.
type OpenAt = { position: Position } | { page: number } | null;

// A PDF put to sleep: its title, where it was, and its place in the tab row.
type Bookmark = { title: string; position: Position; index: number };

// One PDF the reader holds that the manager may not hold yet: loading, failed or open.
type Held =
  | { status: "loading"; openAt: OpenAt; index: number | null }
  | { status: "failed"; message: string }
  | {
      status: "open";
      storage: DocumentStorage;
      item: BucketItem;
      preferences: Preferences;
      openAt: OpenAt;
    };

type Capabilities = {
  documents: ReturnType<DocumentManagerPlugin["provides"]>;
  scroll: ReturnType<ScrollPlugin["provides"]>;
  zoom: ReturnType<ZoomPlugin["provides"]>;
  annotations: ReturnType<AnnotationPlugin["provides"]>;
  exporter: ReturnType<ExportPlugin["provides"]>;
  ui: ReturnType<UIPlugin["provides"]>;
  commands: ReturnType<CommandsPlugin["provides"]>;
  search: ReturnType<SearchPlugin["provides"]>;
  interaction: ReturnType<InteractionManagerPlugin["provides"]>;
  viewport: ReturnType<ViewportPlugin["provides"]>;
};

// EmbedPDF's left sidebar (`sidebar-panel`) holds the thumbnails and outline tabs, and opens on
// its first tab whatever its `defaultTab` says, so for the outline preference the outline goes
// first.
function outlineFirst(ui: Capabilities["ui"]): void {
  const sidebar = ui.getSchema().sidebars["sidebar-panel"];
  if (sidebar === undefined || sidebar.content.type !== "tabs") {
    throw new Error("EmbedPDF's sidebar-panel has no tabs");
  }
  const tabs = sidebar.content.tabs;
  if (!tabs.some((tab) => tab.id === "outline")) {
    throw new Error("EmbedPDF's sidebar-panel has no outline tab");
  }
  if (tabs[0]?.id === "outline") {
    return;
  }
  ui.mergeSchema({
    sidebars: {
      "sidebar-panel": {
        ...sidebar,
        content: {
          ...sidebar.content,
          tabs: [
            ...tabs.filter((tab) => tab.id === "outline"),
            ...tabs.filter((tab) => tab.id !== "outline"),
          ],
        },
      },
    },
  });
}

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

  // Everything the viewer's callbacks share, which outlives renders.
  const host = useRef({
    caps: null as Capabilities | null,
    held: new Map<string, Held>(),
    titles: new Map<string, string>(),
    bookmarks: new Map<string, Bookmark>(),
    // The keys of the open PDFs, the one shown last first.
    recent: [] as string[],
    // The PDF asked for last: the manager's active one once it is open.
    focus: null as string | null,
    // True while the reader itself moves a PDF (opening at a position, back, forward), which is
    // no jump. EmbedPDF announces a page change synchronously inside scrollToPage.
    moving: false,
    // What the toolbar's Night mode button shows pressed: the preference, once a PDF loaded it.
    nightMode: false,
    whenReady: [] as (() => void)[],
    // The PDFs EmbedPDF has laid out. EmbedPDF activates a PDF it opens before it creates that
    // PDF's UI state, which its first layout follows.
    laidOut: new Set<string>(),
    // The position each open PDF had when it stopped being the active one.
    parked: new Map<string, Position>(),
  }).current;

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

  const projection = useCallback((): ReaderProjection => {
    const order = host.caps?.documents.getDocumentOrder() ?? [];
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

  // Where KEY is now. The viewport's top-left corner lies in the first page it shows; the page
  // coordinates of that corner are the visible part's offset in the page, less the gap above or
  // beside the page, in page units. EmbedPDF's scrollToPage adds the viewport's gap to the place
  // these coordinates name (plugin-scroll's getScrollPositionForPage), so they hold it less.
  const positionOf = useCallback(
    (key: string): Position => {
      const { scroll, zoom, viewport } = caps();
      const first = scroll.forDocument(key).getMetrics().pageVisibilityMetrics[0];
      const level = zoom.forDocument(key).getState().zoomLevel;
      if (first === undefined) {
        return { pageNumber: 1, x: 0, y: 0, zoom: level };
      }
      const gap = viewport.getViewportGap();
      return {
        pageNumber: first.pageNumber,
        x: first.original.pageX - (first.viewportX + gap) / first.scaled.scale,
        y: first.original.pageY - (first.viewportY + gap) / first.scaled.scale,
        zoom: level,
      };
    },
    [caps],
  );

  // Where KEY is, shown or not. EmbedPDF shows no page of a PDF that is not the active one, so the
  // reader keeps the position of the active PDF at each scroll, read while EmbedPDF still shows it.
  const placeOf = useCallback(
    (key: string): Position => {
      const parked = host.parked.get(key);
      return caps().documents.getActiveDocumentId() === key || parked === undefined
        ? positionOf(key)
        : parked;
    },
    [host, caps, positionOf],
  );

  // Moves KEY to POSITION; the move records no jump.
  const restore = useCallback(
    (key: string, position: Position) => {
      const { scroll, zoom } = caps();
      const scope = zoom.forDocument(key);
      if (scope.getState().zoomLevel !== position.zoom) {
        scope.requestZoom(position.zoom);
      }
      host.moving = true;
      try {
        scroll.forDocument(key).scrollToPage({
          pageNumber: position.pageNumber,
          pageCoordinates: { x: position.x, y: position.y },
          behavior: "instant",
        });
      } finally {
        host.moving = false;
      }
    },
    [caps, host],
  );

  // EmbedPDF answers its keyboard shortcuts on the whole document (plugin-commands' keyboard
  // utility), for the active PDF, so while the Library is shown the reader disables every
  // category that holds a shortcut command, and the keys reach the library; with no active PDF no
  // shortcut runs, and each activation scopes them again. Setting the disabled categories is a
  // change of EmbedPDF's store, on which EmbedPDF resolves its commands again, so the toolbar's
  // reader buttons also show the reader's own state (Back, Forward, Night mode) once this runs.
  const scopeShortcuts = useCallback(() => {
    const commands = host.caps?.commands;
    const documentId = host.caps?.documents.getActiveDocumentId() ?? null;
    if (commands === undefined || documentId === null) {
      return;
    }
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
  }, [host]);

  const neighbour = useCallback(
    (key: string): string | null => {
      const tabs = projection().tabs;
      const index = tabs.findIndex((tab) => tab.key === key);
      const others = tabs.filter((tab) => tab.key !== key);
      return (others[index] ?? others[index - 1])?.key ?? null;
    },
    [projection],
  );

  // Shows KEY, which the reader holds.
  const activate = useCallback(
    (key: string) => {
      const held = host.held.get(key);
      if (held === undefined) {
        throw new Error(`the reader holds no PDF ${key}`);
      }
      host.focus = key;
      if (held.status === "open") {
        caps().documents.setActiveDocument(key);
      }
      changed();
    },
    [host, caps, changed],
  );

  // Opens KEY, or shows it when the reader holds it. PAGE opens it at that page; a PDF that
  // sleeps opens where it was.
  const open = useCallback(
    (key: string, title: string, page?: number) => {
      host.titles.set(key, title);
      if (host.held.has(key)) {
        activate(key);
        return;
      }
      const bookmark = host.bookmarks.get(key);
      host.bookmarks.delete(key);
      const openAt: OpenAt =
        bookmark !== undefined
          ? { position: bookmark.position }
          : page !== undefined
            ? { page }
            : null;
      const loading: Held = { status: "loading", openAt, index: bookmark?.index ?? null };
      host.held.set(key, loading);
      host.focus = key;
      changed();
      const ready = new Promise<void>((resolve) =>
        host.caps === null ? host.whenReady.push(resolve) : resolve(),
      );
      ready
        .then(() => load(key))
        .then(async (loaded) => {
          if (host.held.get(key) !== loading) {
            return;
          }
          const { documents, exporter, annotations } = caps();
          const storage = new DocumentStorage(
            key,
            loaded.tag,
            () => exporter.forDocument(key).saveAsCopy().toPromise(),
            async () => {
              const scope = annotations.forDocument(key);
              await scope.commit().toPromise();
              // EmbedPDF writes an annotation edit into its document asynchronously, and raises
              // the edit's committed event (which schedules the save) before it clears
              // hasPendingChanges. Once that flag is clear, every edit made so far has scheduled
              // its save.
              await new Promise<void>((resolve) => {
                if (!scope.getState().hasPendingChanges) {
                  resolve();
                  return;
                }
                const stop = scope.onStateChange((state) => {
                  if (!state.hasPendingChanges) {
                    stop();
                    resolve();
                  }
                });
              });
            },
            changed,
          );
          host.held.set(key, {
            status: "open",
            storage,
            item: loaded.item,
            preferences: loaded.preferences,
            openAt: loading.openAt,
          });
          if (host.nightMode !== loaded.preferences.readerNightMode) {
            host.nightMode = loaded.preferences.readerNightMode;
            setNightMode(host.nightMode);
          }
          const response = await documents
            .openDocumentBuffer({
              buffer: loaded.bytes,
              name: `${key}.pdf`,
              documentId: key,
              autoActivate: host.focus === key,
            })
            .toPromise();
          if (response.documentId !== key) {
            throw new Error(`EmbedPDF opened ${key} as document ${response.documentId}`);
          }
          if (loading.index !== null) {
            const before = new Set(
              projection()
                .tabs.slice(0, loading.index)
                .map((tab) => tab.key),
            );
            documents.moveDocument(
              key,
              documents.getDocumentOrder().filter((other) => before.has(other)).length,
            );
          }
          await response.task.toPromise();
          changed();
        })
        .catch((error: Error) => {
          const held = host.held.get(key);
          if (held === undefined) {
            return;
          }
          if (held.status === "open") {
            held.storage.dispose();
          }
          host.held.set(key, { status: "failed", message: error.message });
          changed();
        });
    },
    [host, activate, caps, changed, projection],
  );

  // KEY leaves the manager and the tab row, or, with BOOKMARK, sleeps in the tab row.
  const remove = useCallback(
    (key: string, bookmark: Bookmark | null) => {
      const held = host.held.get(key);
      const next = host.focus === key ? neighbour(key) : host.focus;
      host.held.delete(key);
      host.laidOut.delete(key);
      host.parked.delete(key);
      host.recent = host.recent.filter((other) => other !== key);
      if (bookmark === null) {
        host.titles.delete(key);
      } else {
        host.bookmarks.set(key, bookmark);
      }
      host.focus = next;
      if (held?.status === "open") {
        held.storage.dispose();
        const { documents } = caps();
        const shownNext = next === null ? undefined : host.held.get(next);
        if (next !== null && shownNext?.status === "open") {
          documents.setActiveDocument(next);
        }
        documents.closeDocument(key);
      }
      changed();
      // The tab shown next wakes when it sleeps.
      const sleeping = next === null ? undefined : host.bookmarks.get(next);
      if (next !== null && sleeping !== undefined) {
        open(next, sleeping.title);
      }
    },
    [host, caps, neighbour, changed, open],
  );

  const sleepReader = useCallback(
    async (key: string, automatic: boolean) => {
      const storage = storageOf(key);
      if (storage === null) {
        return;
      }
      await storage.settle();
      if (automatic && !host.recent.slice(AWAKE_READERS).includes(key)) {
        return;
      }
      if (storageOf(key) !== storage) {
        return;
      }
      const index = projection().tabs.findIndex((tab) => tab.key === key);
      remove(key, {
        title: host.titles.get(key) ?? key,
        position: placeOf(key),
        index,
      });
    },
    [host, storageOf, projection, placeOf, remove],
  );

  // The PDFs past the AWAKE_READERS shown last sleep. One that cannot settle stays awake and
  // says why when shown; the next activation tries it again.
  const sleepDrowsy = useCallback(() => {
    for (const key of host.recent.slice(AWAKE_READERS)) {
      sleepReader(key, true).catch(() => undefined);
    }
  }, [host, sleepReader]);

  const close = useCallback(
    async (key: string) => {
      if (host.bookmarks.delete(key)) {
        host.titles.delete(key);
        changed();
        return;
      }
      await storageOf(key)?.settle();
      if (host.held.has(key)) {
        remove(key, null);
      }
    },
    [host, storageOf, remove, changed],
  );

  // The stored PDF replaces the user's copy of KEY, which opens again where it was.
  const reload = useCallback(
    (key: string) => {
      const title = host.titles.get(key) ?? key;
      const index = projection().tabs.findIndex((tab) => tab.key === key);
      const position = placeOf(key);
      // KEY is shown again at once, so no other tab takes its place meanwhile.
      host.focus = null;
      remove(key, { title, position, index });
      open(key, title);
    },
    [host, projection, remove, placeOf, open],
  );

  useEffect(() => {
    onControl({
      open,
      activate: (key) => {
        const bookmark = host.bookmarks.get(key);
        if (bookmark === undefined) {
          activate(key);
        } else {
          open(key, bookmark.title);
        }
      },
      close,
      discard: (key) => {
        host.bookmarks.delete(key);
        remove(key, null);
      },
      sleep: (key) => sleepReader(key, false),
      retitle: (key, title) => {
        if (host.titles.has(key)) {
          host.titles.set(key, title);
        }
        const bookmark = host.bookmarks.get(key);
        if (bookmark !== undefined) {
          host.bookmarks.set(key, { ...bookmark, title });
        }
        changed();
      },
      settleAll: async () => {
        const storages = [...host.held.values()].flatMap((held) =>
          held.status === "open" ? [held.storage] : [],
        );
        await Promise.all(storages.map((storage) => storage.settle()));
      },
    });
  }, [onControl, open, activate, close, remove, sleepReader, changed, host]);

  const walk = useCallback(
    (key: string, step: -1 | 1) => {
      const position = storageOf(key)?.history.step(step, positionOf(key));
      if (position === null || position === undefined) {
        return;
      }
      restore(key, position);
      scopeShortcuts();
    },
    [storageOf, positionOf, restore, scopeShortcuts],
  );

  const toggleNightMode = async (key: string) => {
    const library = await request(LibraryPayloadSchema, "PATCH", "/api/preferences", {
      readerNightMode: !host.nightMode,
    }).catch((error: Error) => {
      storageOf(key)?.show({ text: `Night mode: ${error.message}`, failed: true });
      return null;
    });
    if (library !== null) {
      setNightMode(library.preferences.readerNightMode);
      host.nightMode = library.preferences.readerNightMode;
      scopeShortcuts();
    }
  };

  const libraryView = sessionStorage.getItem(LIBRARY_VIEW_KEY);
  const libraryHref = libraryView === null ? "/" : `/${libraryView}`;

  // The reader's buttons in EmbedPDF's toolbar (withReaderButtons) and their keys. Each acts on
  // the document its command runs for.
  const readerCommands: Command[] = [
    {
      id: "bucket:library",
      label: "Library",
      icon: "bucket-library",
      // Leaving waits until the reading session is reported and every annotation saved.
      action: ({ documentId }) => {
        const storage = storageOf(documentId);
        (storage === null ? Promise.resolve() : storage.settle()).then(
          () => window.location.assign(libraryHref),
          (error: Error) => storage?.show({ text: error.message, failed: true }),
        );
      },
    },
    {
      id: "bucket:back",
      label: "Back (Alt+←)",
      icon: "bucket-back",
      shortcuts: ["Alt+ArrowLeft"],
      categories: ["navigation", "navigation-history"],
      disabled: ({ documentId }) => !(storageOf(documentId)?.history.canStep(-1) ?? false),
      action: ({ documentId }) => walk(documentId, -1),
    },
    {
      id: "bucket:forward",
      label: "Forward (Alt+→)",
      icon: "bucket-forward",
      shortcuts: ["Alt+ArrowRight"],
      categories: ["navigation", "navigation-history"],
      disabled: ({ documentId }) => !(storageOf(documentId)?.history.canStep(1) ?? false),
      action: ({ documentId }) => walk(documentId, 1),
    },
    {
      id: "bucket:night-mode",
      label: "Night mode",
      icon: "bucket-night-mode",
      active: () => host.nightMode,
      action: ({ documentId }) => void toggleNightMode(documentId),
    },
    {
      id: "bucket:copy-link",
      label: "Copy PDF link",
      icon: "bucket-copy-link",
      action: ({ documentId }) => {
        const held = host.held.get(documentId);
        if (held?.status !== "open") {
          throw new Error(`Copy PDF link ran for ${documentId}, which is not open`);
        }
        navigator.clipboard.writeText(held.item.provenance.pdf_url).then(
          () => {
            held.storage.show({ text: COPIED, failed: false });
            setTimeout(() => {
              if (held.storage.status?.text === COPIED) {
                held.storage.show(null);
              }
            }, COPIED_SHOWN_MS);
          },
          (error: Error) => held.storage.show({ text: `Copy link: ${error.message}`, failed: true }),
        );
      },
    },
  ];
  // EmbedPDF keeps the commands registered at onReady; each runs the current render's action.
  const commandsRef = useRef(readerCommands);
  commandsRef.current = readerCommands;

  const onReady = (registry: PluginRegistry) => {
    const pageControlStyle = document.createElement("style");
    pageControlStyle.textContent =
      '.transition-opacity:has(input[inputmode="numeric"]) { opacity: 1 !important; }';
    viewerRoot().append(pageControlStyle);
    const found: Capabilities = {
      documents: plugin<DocumentManagerPlugin>(registry, DocumentManagerPlugin.id),
      scroll: plugin<ScrollPlugin>(registry, ScrollPlugin.id),
      zoom: plugin<ZoomPlugin>(registry, ZoomPlugin.id),
      annotations: plugin<AnnotationPlugin>(registry, AnnotationPlugin.id),
      exporter: plugin<ExportPlugin>(registry, ExportPlugin.id),
      ui: plugin<UIPlugin>(registry, UIPlugin.id),
      commands: plugin<CommandsPlugin>(registry, CommandsPlugin.id),
      search: plugin<SearchPlugin>(registry, SearchPlugin.id),
      interaction: plugin<InteractionManagerPlugin>(registry, InteractionManagerPlugin.id),
      viewport: plugin<ViewportPlugin>(registry, ViewportPlugin.id),
    };
    host.caps = found;
    const { documents, scroll, ui, annotations, commands, viewport } = found;
    commands.registerCommand(DEFAULT_TOOL);
    commands.registerCommand(findCommand(viewerRoot));
    for (const command of SCROLL_COMMANDS) {
      commands.registerCommand(command);
    }
    for (const command of commandsRef.current) {
      commands.registerCommand({
        ...command,
        action: (context) =>
          commandsRef.current.find((other) => other.id === command.id)?.action(context),
      });
    }
    // EmbedPDF's mode:view closes the top/secondary toolbar. mode:annotate opens its
    // annotation-toolbar; the other editing modes open their own secondary toolbars.
    // Track precisely this existing UI state, including transitions through its compact menu.
    const updateStylusMode = (documentId: string) => {
      const activeToolbar = ui.forDocument(documentId).getActiveToolbar("top", "secondary");
      const view = activeToolbar === null;
      const annotate = activeToolbar === "annotation-toolbar";
      const container = viewerRef.current?.container;
      if (container !== null && container !== undefined) {
        container.dataset.bucketStylusMode = view ? "view" : "edit";
        container.dataset.bucketStylusAnnotation = String(annotate);
        container.dispatchEvent(new Event("bucket-stylus-mode-changed"));
        if (shownRef.current) {
          window.dispatchEvent(
            new CustomEvent("bucket-stylus-mode", {
              detail: view ? "view" : annotate ? "annotate" : "edit",
            }),
          );
        }
      }
    };
    ui.onToolbarChanged(({ documentId, placement, slot }) => {
      if (placement === "top" && slot === "secondary") {
        updateStylusMode(documentId);
        // EmbedPDF's mode command resets the annotation lock after changing the toolbar.
        queueMicrotask(() => {
          annotations.setLocked(
            { type: LockModeType.Include, categories: ["form", "link"] },
            documentId,
          );
        });
      }
    });
    const toolbar = ui.getSchema().toolbars["main-toolbar"];
    const pageControls = ui.getSchema().overlays?.["page-controls"];
    if (toolbar === undefined) {
      throw new Error("EmbedPDF has no main-toolbar");
    }
    if (pageControls === undefined) {
      throw new Error("EmbedPDF has no page-controls overlay");
    }
    ui.mergeSchema({
      toolbars: {
        "main-toolbar": {
          ...toolbar,
          items: withReaderButtons(toolbar.items, inTab),
        },
      },
      overlays: { "page-controls": { ...pageControls, defaultEnabled: false } },
    });
    scopeShortcuts();

    scroll.onLayoutReady(({ documentId, isInitial, totalPages }) => {
      if (!isInitial) {
        return;
      }
      const held = host.held.get(documentId);
      if (held?.status !== "open") {
        throw new Error(`EmbedPDF laid out ${documentId}, which the reader is not opening`);
      }
      host.laidOut.add(documentId);
      updateStylusMode(documentId);
      ui.disableOverlay("page-controls", documentId);
      const { storage, openAt, item, preferences } = held;
      if (preferences.outlineOnOpen) {
        outlineFirst(ui);
        ui.forDocument(documentId).setActiveSidebar("left", "main", "sidebar-panel");
      }
      if (openAt !== null && "position" in openAt) {
        storage.recordedPage = openAt.position.pageNumber;
        // EmbedPDF's zoom plugin gates a PDF's viewport until its first zoom, which waits for the
        // viewport to have a size; a zoom asked for before then is dropped.
        const { position } = openAt;
        if (viewport.isGated(documentId)) {
          const stop = viewport.onGateChange((event) => {
            if (event.documentId === documentId && !event.isGated) {
              stop();
              restore(documentId, position);
            }
          });
        } else {
          restore(documentId, position);
        }
      } else {
        const reading = item.reading;
        const page = openAt?.page ?? (reading.status === "viewed" ? reading.page : 1);
        storage.recordedPage = page;
        // EmbedPDF's page controls read the page count when they mount and then only at a page
        // change, and they can mount before the layout; this scroll, to page 1 too, is that change.
        if (page <= totalPages) {
          host.moving = true;
          try {
            scroll.forDocument(documentId).scrollToPage({ pageNumber: page, behavior: "instant" });
          } finally {
            host.moving = false;
          }
        }
      }
      storage.page = storage.recordedPage;
      storage.session.start(storage.recordedPage, isShown(documentId));
    });
    scroll.onPageChangeState(({ documentId, state: change }) => {
      // A page change starts before the viewport moves, so the position is still the one the
      // jump leaves. A smooth one may never report its end.
      if (change.isChanging && !host.moving && change.fromPage !== change.targetPage) {
        storageOf(documentId)?.history.jumped(positionOf(documentId));
        scopeShortcuts();
      }
    });
    scroll.onScroll(({ documentId }) => {
      if (documents.getActiveDocumentId() === documentId && host.laidOut.has(documentId)) {
        host.parked.set(documentId, positionOf(documentId));
      }
    });
    scroll.onPageChange(({ documentId, pageNumber, totalPages }) => {
      storageOf(documentId)?.pageChanged(pageNumber, totalPages, isShown(documentId));
      if (documents.getActiveDocumentId() === documentId) {
        callbacks.current.onPage?.(documentId, pageNumber);
      }
    });
    annotations.onAnnotationEvent((event) => {
      if (event.type === "loaded" || !event.committed) {
        return;
      }
      const storage = storageOf(event.documentId);
      if (storage === null) {
        throw new Error(`EmbedPDF committed an edit to ${event.documentId}, which is not open`);
      }
      storage.edited();
    });
    documents.onActiveDocumentChanged(({ previousDocumentId, currentDocumentId }) => {
      if (previousDocumentId !== null) {
        storageOf(previousDocumentId)?.session.hidden();
      }
      if (currentDocumentId !== null) {
        // EmbedPDF activates another open PDF when it closes the active one; a PDF the reader is
        // still loading to show keeps the focus, and is activated once loaded.
        const focus = host.focus === null ? undefined : host.held.get(host.focus);
        if (focus?.status !== "loading") {
          host.focus = currentDocumentId;
        }
        host.recent = [
          currentDocumentId,
          ...host.recent.filter((key) => key !== currentDocumentId),
        ];
        const storage = storageOf(currentDocumentId);
        storage?.session.start(storage.page, isShown(currentDocumentId));
        if (host.laidOut.has(currentDocumentId)) {
          updateStylusMode(currentDocumentId);
        }
        callbacks.current.onPage?.(currentDocumentId, storage?.page ?? 1);
      }
      changed();
      scopeShortcuts();
      sleepDrowsy();
    });
    documents.onDocumentOrderChanged(changed);
    documents.onDocumentClosed(changed);
    for (const resolve of host.whenReady.splice(0)) {
      resolve();
    }
  };

  // The PDF shown: its storage while it is open.
  const activeStorage = useCallback((): DocumentStorage | null => {
    const key = host.caps?.documents.getActiveDocumentId() ?? null;
    return key === null ? null : storageOf(key);
  }, [host, storageOf]);

  // The reader shown again starts reading its PDF's page; hidden, that stretch ends and reports.
  useEffect(() => {
    const storage = activeStorage();
    if (storage !== null) {
      if (shown) {
        storage.session.start(storage.page, isShown(storage.key));
      } else {
        storage.session.hidden();
      }
    }
    scopeShortcuts();
  }, [shown, activeStorage, isShown, scopeShortcuts]);

  useEffect(() => {
    const changedVisibility = () => {
      const storage = activeStorage();
      if (storage === null) {
        return;
      }
      if (isShown(storage.key)) {
        storage.session.start(storage.page, true);
      } else {
        storage.session.hidden();
      }
    };
    document.addEventListener("visibilitychange", changedVisibility);
    return () => document.removeEventListener("visibilitychange", changedVisibility);
  }, [activeStorage, isShown]);

  // Any key is reading input while the reader is shown: EmbedPDF's viewer holds no focus of its
  // own, so the keys arrive at the document, as EmbedPDF's own shortcuts do.
  const readingInput = useCallback(() => {
    const storage = activeStorage();
    if (storage !== null) {
      storage.session.input(storage.page, isShown(storage.key));
    }
  }, [activeStorage, isShown]);
  useEffect(() => {
    if (!shown) {
      return;
    }
    document.addEventListener("keydown", readingInput);
    return () => document.removeEventListener("keydown", readingInput);
  }, [shown, readingInput]);

  // Enter in the search field goes to the next match and Shift+Enter to the one before, as in a
  // browser's find bar; EmbedPDF's field answers no key.
  useEffect(() => {
    const pressed = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== "Enter") {
        return;
      }
      if (!(event.target instanceof HTMLInputElement) || !event.target.matches(SEARCH_FIELD)) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        caps().search.previousResult();
      } else {
        caps().search.nextResult();
      }
    };
    const root = viewerRoot();
    root.addEventListener("keydown", pressed);
    return () => root.removeEventListener("keydown", pressed);
  }, [caps, viewerRoot]);

  // A press of a button other than the primary one (the context menu's) leaves the text
  // selection as it is: EmbedPDF's selection clears on every press, and its pointer events carry
  // no button, so the reader pauses EmbedPDF's interaction manager until the button is released,
  // and the selection menu (with its highlight) stays on the selected text.
  useEffect(() => {
    const container = viewerRef.current?.container;
    if (container === null || container === undefined) {
      throw new Error("the reader's viewer has no container");
    }
    let paused = false;
    const pressed = (event: PointerEvent) => {
      if (event.button === 0 || event.pointerType === "pen" || host.caps === null) {
        return;
      }
      paused = true;
      host.caps.interaction.pause();
    };
    const released = () => {
      if (paused) {
        paused = false;
        host.caps?.interaction.resume();
      }
    };
    const menu = (event: MouseEvent) => {
      if (event.composedPath().some((node) => node instanceof Element && node.matches(PAGE_BOX))) {
        event.preventDefault();
      }
    };
    container.addEventListener("pointerdown", pressed, { capture: true });
    container.addEventListener("contextmenu", menu);
    window.addEventListener("pointerup", released, { capture: true });
    window.addEventListener("pointercancel", released, { capture: true });
    window.addEventListener("blur", released);
    return () => {
      container.removeEventListener("pointerdown", pressed, { capture: true });
      container.removeEventListener("contextmenu", menu);
      window.removeEventListener("pointerup", released, { capture: true });
      window.removeEventListener("pointercancel", released, { capture: true });
      window.removeEventListener("blur", released);
    };
  }, [host]);

  // EmbedPDF's Annotation plugin owns selection and deletion but binds no Delete/Backspace
  // shortcut in the viewer. Keep those keys scoped to the visible Annotate toolbar; inputs,
  // editable annotation text and modifier-key shortcuts retain their native behavior.
  useEffect(() => {
    if (!shown) {
      return;
    }
    const pressed = (event: KeyboardEvent) => {
      if (
        (event.key !== "Delete" && event.key !== "Backspace") ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
      ) {
        return;
      }
      const typing = event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            (node.matches(
              "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
            ) ||
              (node instanceof HTMLElement && node.isContentEditable)),
        );
      if (typing || host.caps === null) {
        return;
      }
      const { documents, ui, annotations } = host.caps;
      const documentId = documents.getActiveDocumentId();
      if (
        documentId === null ||
        !host.laidOut.has(documentId) ||
        ui.forDocument(documentId).getActiveToolbar("top", "secondary") !== "annotation-toolbar"
      ) {
        return;
      }
      const scope = annotations.forDocument(documentId);
      const selected = scope
        .getSelectedAnnotations()
        .filter(({ object }) => object.type !== PdfAnnotationSubtype.LINK);
      if (selected.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      scope.deleteAnnotations(
        selected.map(({ object }) => ({
          pageIndex: object.pageIndex,
          id: object.id,
        })),
      );
    };
    document.addEventListener("keydown", pressed, { capture: true });
    return () => document.removeEventListener("keydown", pressed, { capture: true });
  }, [shown, host]);

  // View forces pen highlighting; Annotate keeps pen tools native but its eraser deletes
  // annotations. Other editing modes retain their existing native input.
  useEffect(() => {
    if (!shown || host.caps === null) {
      return;
    }
    const documentId = host.caps.documents.getActiveDocumentId();
    if (documentId !== null && host.laidOut.has(documentId)) {
      const toolbar = host.caps.ui.forDocument(documentId).getActiveToolbar("top", "secondary");
      window.dispatchEvent(
        new CustomEvent("bucket-stylus-mode", {
          detail:
            toolbar === null ? "view" : toolbar === "annotation-toolbar" ? "annotate" : "edit",
        }),
      );
    }
  }, [shown, host]);

  useEffect(() => {
    const container = viewerRef.current?.container;
    if (container === null || container === undefined) {
      throw new Error("the reader's viewer has no container");
    }
    // True between a pen's press and its release, and the tool it found then.
    let penDown = false;
    let restoring: string | null = null;
    let erasing: number | null = null;
    let eraserLast: { x: number; y: number } | null = null;
    const activeDocument = () => host.caps?.documents.getActiveDocumentId() ?? null;
    const activeToolbar = () => {
      const documentId = activeDocument();
      return documentId === null || host.caps === null || !host.laidOut.has(documentId)
        ? undefined
        : host.caps.ui.forDocument(documentId).getActiveToolbar("top", "secondary");
    };
    const inView = () => activeToolbar() === null;
    const inAnnotate = () => activeToolbar() === "annotation-toolbar";

    // Liang–Barsky segment/rectangle clipping with a 3 CSS-pixel nib tolerance. Intersect
    // the complete distance between samples: fast eraser movement must not skip an annotation.
    const crosses = (
      from: { x: number; y: number },
      to: { x: number; y: number },
      left: number,
      top: number,
      right: number,
      bottom: number,
    ) => {
      let enter = 0;
      let leave = 1;
      for (const [start, delta, lo, hi] of [
        [from.x, to.x - from.x, left - 3, right + 3],
        [from.y, to.y - from.y, top - 3, bottom + 3],
      ]) {
        if (delta === 0) {
          if (start < lo || start > hi) {
            return false;
          }
        } else {
          const a = (lo - start) / delta;
          const b = (hi - start) / delta;
          enter = Math.max(enter, Math.min(a, b));
          leave = Math.min(leave, Math.max(a, b));
          if (enter > leave) {
            return false;
          }
        }
      }
      return true;
    };

    const eraseBetween = (
      from: { x: number; y: number },
      to: { x: number; y: number },
      annotate: boolean,
    ) => {
      const documentId = activeDocument();
      const root = container.shadowRoot;
      if (host.caps === null || documentId === null || root === null) {
        throw new Error("eraser reached a reader without its annotation and page geometry");
      }
      const annotations = host.caps.annotations.forDocument(documentId);
      const scroll = host.caps.scroll.forDocument(documentId);
      // The reader's rendered page boxes are in the same order as the scroll plugin's
      // renderedPageIndexes. Use EmbedPDF's own page-rect transforms so rotation, zoom,
      // page dimensions and the scroll strategy agree with the annotations it paints.
      const boxes = [...root.querySelectorAll<HTMLElement>(PAGE_BOX)];
      const indexes = scroll.getMetrics().renderedPageIndexes;
      if (boxes.length !== indexes.length) {
        return;
      } // the viewer is between page layouts
      const pages = scroll.getLayout().virtualItems.flatMap((item) => item.pageLayouts);
      const deleted: { pageIndex: number; id: string }[] = [];
      for (const [i, box] of boxes.entries()) {
        const pageIndex = indexes[i];
        const page = pages.find((candidate) => candidate.pageIndex === pageIndex);
        if (page === undefined) {
          continue;
        }
        const entire = scroll.getRectPositionForPage(pageIndex, {
          origin: { x: 0, y: 0 },
          size: { width: page.width, height: page.height },
        });
        const visible = box.getBoundingClientRect();
        if (
          entire === null ||
          entire.size.width === 0 ||
          entire.size.height === 0 ||
          visible.width === 0 ||
          visible.height === 0
        ) {
          continue;
        }
        for (const tracked of annotations.getAnnotations({ pageIndex })) {
          const annotation = tracked.object;
          if (
            tracked.commitState === "deleted" ||
            (!annotate && annotation.type !== PdfAnnotationSubtype.HIGHLIGHT) ||
            (annotate &&
              (annotation.type === PdfAnnotationSubtype.LINK ||
                annotation.type === PdfAnnotationSubtype.WIDGET ||
                annotation.flags?.includes("locked") === true ||
                annotation.flags?.includes("readOnly") === true))
          ) {
            continue;
          }
          // Text markup is a union of disjoint glyph rectangles, not one bounding box.
          // Ink has independent pen strokes; test their short segment bounds rather than
          // deleting unrelated ink in the whitespace between distant strokes. For shapes,
          // stamps, and notes EmbedPDF's own annotation rectangle supplies the hit region.
          const regions =
            annotation.type === PdfAnnotationSubtype.INK
              ? annotation.inkList.flatMap(({ points }) =>
                  points.length < 2
                    ? points.map((point) =>
                        expandRect(rectFromPoints([point]), annotation.strokeWidth / 2),
                      )
                    : points
                        .slice(1)
                        .map((point, i) =>
                          expandRect(
                            rectFromPoints([points[i], point]),
                            annotation.strokeWidth / 2,
                          ),
                        ),
                )
              : "segmentRects" in annotation && Array.isArray(annotation.segmentRects)
                ? annotation.segmentRects
                : [annotation.rect];
          if (
            regions.some((segment) => {
              const rect = scroll.getRectPositionForPage(pageIndex, segment);
              if (rect === null) {
                return false;
              }
              const left =
                visible.left +
                ((rect.origin.x - entire.origin.x) / entire.size.width) * visible.width;
              const top =
                visible.top +
                ((rect.origin.y - entire.origin.y) / entire.size.height) * visible.height;
              const right = left + (rect.size.width / entire.size.width) * visible.width;
              const bottom = top + (rect.size.height / entire.size.height) * visible.height;
              return crosses(from, to, left, top, right, bottom);
            })
          ) {
            deleted.push({ pageIndex, id: annotation.id });
          }
        }
      }
      if (deleted.length > 0) {
        annotations.deleteAnnotations(deleted);
      }
    };

    const suppress = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const eraserMoved = (event: PointerEvent) => {
      if (event.pointerType !== "pen" || event.pointerId !== erasing || eraserLast === null) {
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      eraseBetween(eraserLast, point, inAnnotate());
      eraserLast = point;
      suppress(event);
    };
    const eraserEnded = (event: PointerEvent) => {
      if (event.pointerType !== "pen" || event.pointerId !== erasing) {
        return;
      }
      if (event.type === "pointerup" && eraserLast !== null) {
        eraseBetween(eraserLast, { x: event.clientX, y: event.clientY }, inAnnotate());
      }
      erasing = null;
      eraserLast = null;
      suppress(event);
    };
    // A press drew on a page, not on the toolbar or a sidebar, only when its path holds a page box.
    const onPage = (event: PointerEvent) =>
      event.composedPath().some((node) => node instanceof Element && node.matches(PAGE_BOX));
    const pressed = (event: PointerEvent) => {
      if (
        event.pointerType !== "pen" ||
        (!inView() && !inAnnotate()) ||
        penDown ||
        erasing !== null ||
        !onPage(event)
      ) {
        return;
      }
      const documentId = activeDocument();
      if (host.caps === null || documentId === null) {
        throw new Error("a pen pressed a page before the viewer was ready");
      }
      if (event.button === 5 || (event.buttons & 32) !== 0) {
        erasing = event.pointerId;
        eraserLast = { x: event.clientX, y: event.clientY };
        eraseBetween(eraserLast, eraserLast, inAnnotate());
        suppress(event); // do not select text, draw, or activate annotations with the eraser
        return;
      }
      if (!inView()) {
        return;
      }
      const annotations = host.caps.annotations.forDocument(documentId);
      penDown = true;
      restoring = annotations.getActiveTool()?.id ?? null;
      annotations.setActiveTool(HIGHLIGHT_TOOL);
    };
    const restoreTool = () => {
      if (!penDown) {
        return;
      }
      penDown = false;
      const documentId = activeDocument();
      const previous = restoring;
      restoring = null;
      if (host.caps === null || documentId === null) {
        return;
      }
      const annotations = host.caps.annotations.forDocument(documentId);
      // The stroke leaves the highlighter in hand. A pen press on a toolbar button left that
      // button's tool in hand instead, and the release must not undo the button.
      if (annotations.getActiveTool()?.id === HIGHLIGHT_TOOL) {
        annotations.setActiveTool(previous);
      }
    };
    const lostFocus = () => {
      erasing = null;
      eraserLast = null;
      restoreTool();
    };
    const released = (event: PointerEvent) => {
      if (event.pointerType === "pen") {
        restoreTool();
      }
    };
    container.addEventListener("pointerdown", pressed, { capture: true });
    container.addEventListener("bucket-stylus-mode-changed", lostFocus);
    window.addEventListener("pointermove", eraserMoved, { capture: true });
    window.addEventListener("pointerup", eraserEnded, { capture: true });
    window.addEventListener("pointercancel", eraserEnded, { capture: true });
    // A stroke can finish outside the page or even outside the reader's container.
    window.addEventListener("pointerup", released);
    window.addEventListener("pointercancel", released);
    window.addEventListener("blur", lostFocus);
    return () => {
      container.removeEventListener("pointerdown", pressed, { capture: true });
      container.removeEventListener("bucket-stylus-mode-changed", lostFocus);
      window.removeEventListener("pointermove", eraserMoved, { capture: true });
      window.removeEventListener("pointerup", eraserEnded, { capture: true });
      window.removeEventListener("pointercancel", eraserEnded, {
        capture: true,
      });
      window.removeEventListener("pointerup", released);
      window.removeEventListener("pointercancel", released);
      window.removeEventListener("blur", lostFocus);
    };
  }, [host]);

  useEffect(() => {
    const root = viewerRoot();
    const sheet = document.createElement("style");
    sheet.textContent = nightMode ? `${NIGHT_PAGES} { filter: invert(1) hue-rotate(180deg); }` : "";
    root.append(sheet);
    return () => sheet.remove();
  }, [nightMode, viewerRoot]);

  // The viewer follows the theme preference the page's root carries (index.css).
  useEffect(() => {
    const root = document.documentElement;
    const follow = new MutationObserver(() =>
      viewerRef.current?.container?.setTheme(ThemeSchema.parse(root.dataset.theme)),
    );
    follow.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => follow.disconnect();
  }, []);

  // Leaving the page while an annotation is not yet saved asks first.
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      const unsaved = [...host.held.values()].some(
        (held) => held.status === "open" && held.storage.unsaved(),
      );
      if (unsaved) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [host]);

  const config = useMemo<PDFViewerConfig>(
    () => ({
      // The engine fetches it from a worker, where a path names nothing.
      wasmUrl: new URL(pdfiumWasm, window.location.href).href,
      fontFallback: fallbackFonts(new URL("/", window.location.href)),
      icons: READER_ICONS,
      tabBar: "never",
      theme: {
        preference: ThemeSchema.parse(document.documentElement.dataset.theme),
      },
      fonts: {
        ui: {
          family: "Inter, 'Segoe UI', system-ui, sans-serif",
          stylesheetUrl: null,
        },
        signature: null,
      },
      disabledCategories: VIEWER_DISABLED,
      annotations: {
        tools: [{ id: "link", categories: ["annotation", "markup", "link"] }],
        locked: { type: LockModeType.Include, categories: ["form", "link"] },
      },
      // EmbedPDF's viewer makes the hand tool the default on a touch device ('mobile'), which it
      // detects by `ontouchstart`, and WebKitGTK has it on every machine: a drag selects text.
      pan: { defaultMode: "never" },
      documentManager: { initialDocuments: [] },
    }),
    [],
  );

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
            onClick={() => reload(focus)}
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
