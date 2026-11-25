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
  type PDFViewerConfig,
  type PDFViewerRef,
  type PluginRegistry,
  ScrollPlugin,
  SearchPlugin,
  type ToolbarItem,
  UIPlugin,
  ViewportPlugin,
  type ZoomLevel,
  ZoomMode,
  ZoomPlugin,
} from "@embedpdf/react-pdf-viewer";
import { ArrowLeft, ArrowRight, type IconNode, Library, Link, Moon } from "lucide";
import { type RefObject, useEffect } from "react";
import { type BucketItem, type RecordedZoom, ThemeSchema } from "../../contract/library";
import type { DocumentStorage, Position } from "./documentStorage";
import { fallbackFonts } from "./fallbackFonts";
import { stylusMode } from "./pointerInput";
import {
  type Capabilities,
  type OpenAt,
  plugin,
  type ReaderHost,
  SEARCH_FIELD,
  SEARCH_PANEL,
} from "./readerHost";

export const VIEWER_DISABLED = ["document", "redaction"];

const NIGHT_PAGES = 'div[style*="transform-origin"][style*="background-color: rgb(255, 255, 255)"]';

const LINE_STEP = 40;
const PAGE_SHARE = 0.9;

const ZOOM_MODES = {
  automatic: ZoomMode.Automatic,
  "fit-page": ZoomMode.FitPage,
  "fit-width": ZoomMode.FitWidth,
} as const;

function viewerZoom(recorded: RecordedZoom): ZoomLevel {
  return typeof recorded === "number" ? recorded : ZOOM_MODES[recorded];
}

function startPage(openAt: { page: number } | null, item: BucketItem): number {
  if (openAt !== null) {
    return openAt.page;
  }
  return item.reading.status === "viewed" ? item.reading.page : 1;
}

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
  scrollCommand(
    "page-up",
    ["PageUp", "Shift+Space"],
    ({ top, height }) => top - height * PAGE_SHARE,
  ),
  scrollCommand("start", ["Home"], () => 0),
  scrollCommand("end", ["End"], ({ end }) => end),
];

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

export function viewerConfig(): PDFViewerConfig {
  return {
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
    pan: { defaultMode: "never" },
    documentManager: { initialDocuments: [] },
  };
}

function capabilities(registry: PluginRegistry): Capabilities {
  return {
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
}

function registerCommands(
  commands: Capabilities["commands"],
  viewerRoot: () => ShadowRoot,
  reader: RefObject<Command[]>,
) {
  commands.registerCommand(DEFAULT_TOOL);
  commands.registerCommand(findCommand(viewerRoot));
  for (const command of SCROLL_COMMANDS) {
    commands.registerCommand(command);
  }
  for (const command of reader.current) {
    commands.registerCommand({
      ...command,
      action: (context) => reader.current.find((other) => other.id === command.id)?.action(context),
    });
  }
}

function addReaderButtons(ui: Capabilities["ui"], inTab: boolean) {
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
}

export type ViewerContext = {
  host: ReaderHost;
  viewerRef: RefObject<PDFViewerRef | null>;
  viewerRoot: () => ShadowRoot;
  shownRef: RefObject<boolean>;
  onPage: () => ((key: string, page: number) => void) | undefined;
  commandsRef: RefObject<Command[]>;
  inTab: boolean;
  scopeShortcuts: () => void;
  restoreOnceSized: (key: string, position: Position) => void;
  scrollToStart: (key: string, page: number) => void;
  storageOf: (key: string) => DocumentStorage | null;
  positionOf: (key: string) => Position;
  isShown: (key: string) => boolean;
  changed: () => void;
  sleepDrowsy: () => void;
};

function updateStylusMode(context: ViewerContext, documentId: string) {
  const ui = context.host.caps?.ui;
  const container = context.viewerRef.current?.container;
  if (ui === undefined || container === null || container === undefined) {
    return;
  }
  const mode = stylusMode(ui.forDocument(documentId).getActiveToolbar("top", "secondary"));
  container.dataset.bucketStylusMode = mode === "view" ? "view" : "edit";
  container.dataset.bucketStylusAnnotation = String(mode === "annotate");
  container.dispatchEvent(new Event("bucket-stylus-mode-changed"));
  if (context.shownRef.current) {
    window.dispatchEvent(new CustomEvent("bucket-stylus-mode", { detail: mode }));
  }
}

function laidOut(context: ViewerContext, documentId: string, totalPages: number) {
  const { host } = context;
  const held = host.held.get(documentId);
  if (held?.status !== "open" || host.caps === null) {
    throw new Error(`EmbedPDF laid out ${documentId}, which the reader is not opening`);
  }
  const { ui } = host.caps;
  host.laidOut.add(documentId);
  updateStylusMode(context, documentId);
  ui.disableOverlay("page-controls", documentId);
  const { storage, openAt, item, preferences } = held;
  if (preferences.outlineOnOpen) {
    outlineFirst(ui);
    ui.forDocument(documentId).setActiveSidebar("left", "main", "sidebar-panel");
  }
  if (isPosition(openAt)) {
    storage.opened(openAt.position.pageNumber, totalPages, openAt.position.zoom);
    context.restoreOnceSized(documentId, openAt.position);
  } else {
    const page = startPage(openAt, item);
    const recorded = item.reading.status === "viewed" ? item.reading.zoom : undefined;
    const zoom =
      recorded ?? host.caps.zoom.forDocument(documentId).getState().zoomLevel;
    storage.opened(page, totalPages, zoom);
    if (page <= totalPages) {
      if (recorded === undefined) {
        context.scrollToStart(documentId, page);
      } else {
        context.restoreOnceSized(documentId, {
          pageNumber: page,
          x: 0,
          y: 0,
          zoom: viewerZoom(recorded),
        });
      }
    }
  }
  storage.session.start(storage.recordedPage, context.isShown(documentId));
}

function isPosition(openAt: OpenAt): openAt is { position: Position } {
  return openAt !== null && "position" in openAt;
}

function activated(context: ViewerContext, current: string) {
  const { host, storageOf } = context;
  const focus = host.focus === null ? undefined : host.held.get(host.focus);
  if (focus?.status !== "loading") {
    host.focus = current;
  }
  host.recent = [current, ...host.recent.filter((key) => key !== current)];
  if (host.laidOut.has(current)) {
    updateStylusMode(context, current);
  }
  const storage = storageOf(current);
  if (storage !== null) {
    storage.session.start(storage.page, context.isShown(current));
    context.onPage()?.(current, storage.page);
  }
}

function releaseZoomGate(caps: Capabilities, documentId: string) {
  const { viewport, zoom, scroll } = caps;
  if (!viewport.hasGate("zoom", documentId)) {
    return;
  }
  const metrics = viewport.forDocument(documentId).getMetrics();
  const spreads = scroll.forDocument(documentId).getSpreadPagesWithRotatedSize();
  console.info("reader zoom gate", {
    documentId,
    clientWidth: metrics.clientWidth,
    clientHeight: metrics.clientHeight,
    spreads: spreads.length,
  });
  if (metrics.clientWidth === 0 || metrics.clientHeight === 0 || spreads.length === 0) {
    return;
  }
  viewport.releaseGate("zoom", documentId);
  const scope = zoom.forDocument(documentId);
  scope.requestZoom(scope.getState().zoomLevel);
  console.info("reader zoom gate released", {
    documentId,
    zoom: scope.getState().zoomLevel,
  });
}

export function connectViewer(registry: PluginRegistry, context: ViewerContext) {
  const { host, storageOf, positionOf, scopeShortcuts, changed, isShown } = context;
  const pageControlStyle = document.createElement("style");
  pageControlStyle.textContent =
    '.transition-opacity:has(input[inputmode="numeric"]) { opacity: 1 !important; }';
  context.viewerRoot().append(pageControlStyle);
  const found = capabilities(registry);
  host.caps = found;
  const { documents, scroll, ui, annotations, commands, viewport } = found;
  registerCommands(commands, context.viewerRoot, context.commandsRef);
  ui.onToolbarChanged(({ documentId, placement, slot }) => {
    if (placement === "top" && slot === "secondary") {
      updateStylusMode(context, documentId);
      queueMicrotask(() => {
        annotations.setLocked(
          { type: LockModeType.Include, categories: ["form", "link"] },
          documentId,
        );
      });
    }
  });
  addReaderButtons(ui, context.inTab);
  scopeShortcuts();

  scroll.onLayoutReady(({ documentId, isInitial, totalPages }) => {
    if (isInitial) {
      laidOut(context, documentId, totalPages);
    }
    releaseZoomGate(found, documentId);
  });
  scroll.onPageChangeState(({ documentId, state: change }) => {
    console.info("reader page change state", {
      documentId,
      changing: change.isChanging,
      fromPage: change.fromPage,
      targetPage: change.targetPage,
    });
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
  found.zoom.onZoomChange(({ documentId, level }) => {
    if (host.laidOut.has(documentId)) {
      storageOf(documentId)?.zoomChanged(level);
    }
  });
  scroll.onPageChange(({ documentId, pageNumber, totalPages }) => {
    console.info("reader page changed", {
      documentId,
      pageNumber,
      totalPages,
      shown: isShown(documentId),
    });
    storageOf(documentId)?.pageChanged(pageNumber, totalPages, isShown(documentId));
    if (documents.getActiveDocumentId() === documentId) {
      context.onPage()?.(documentId, pageNumber);
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
      activated(context, currentDocumentId);
    }
    changed();
    scopeShortcuts();
    context.sleepDrowsy();
  });
  viewport.onViewportChange(({ documentId }) => releaseZoomGate(found, documentId));
  documents.onDocumentOrderChanged(changed);
  documents.onDocumentClosed(changed);
  for (const resolve of host.whenReady.splice(0)) {
    resolve();
  }
}

export function useSearchKeys(caps: () => Capabilities, viewerRoot: () => ShadowRoot) {
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
}

export function useViewerTheme(
  viewerRef: RefObject<PDFViewerRef | null>,
  viewerRoot: () => ShadowRoot,
  nightMode: boolean,
) {
  useEffect(() => {
    const root = viewerRoot();
    const sheet = document.createElement("style");
    sheet.textContent = nightMode ? `${NIGHT_PAGES} { filter: invert(1) hue-rotate(180deg); }` : "";
    root.append(sheet);
    return () => sheet.remove();
  }, [nightMode, viewerRoot]);

  useEffect(() => {
    const root = document.documentElement;
    const follow = new MutationObserver(() =>
      viewerRef.current?.container?.setTheme(ThemeSchema.parse(root.dataset.theme)),
    );
    follow.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => follow.disconnect();
  }, [viewerRef]);
}
