// What the reader's parts share: the EmbedPDF capabilities it uses, the PDFs it holds, and the
// host record that outlives the reader's renders, which every part reads and writes.

import type {
  AnnotationPlugin,
  CommandsPlugin,
  DocumentManagerPlugin,
  ExportPlugin,
  InteractionManagerPlugin,
  PluginRegistry,
  ScrollPlugin,
  SearchPlugin,
  UIPlugin,
  ViewportPlugin,
  ZoomPlugin,
} from "@embedpdf/react-pdf-viewer";
import type { BucketItem, Preferences } from "../../contract/library";
import type { DocumentStorage, Position } from "./documentStorage";

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

// The box EmbedPDF draws a page in, the element a pointer must land on to be drawing (the desktop
// suite's page boxes name the same element). A press on the toolbar or a sidebar is not one.
export const PAGE_BOX = 'div[style*="transform-origin"][style*="background-color"]';

// EmbedPDF's search panel (its sidebar `search-panel`) and the field in it.
export const SEARCH_PANEL = "search-panel";
export const SEARCH_FIELD = `[data-sidebar-id="${SEARCH_PANEL}"] input[type="text"]`;

export function plugin<
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

// Where a PDF opens: an exact position (a bookmark), a page, or the page last viewed.
export type OpenAt = { position: Position } | { page: number } | null;

// A PDF put to sleep: its title, where it was, and its place in the tab row.
export type Bookmark = { title: string; position: Position; index: number };

// One PDF the reader holds that the manager may not hold yet: loading, failed or open.
export type Held =
  | { status: "loading"; openAt: OpenAt; index: number | null }
  | { status: "failed"; message: string }
  | {
      status: "open";
      storage: DocumentStorage;
      item: BucketItem;
      preferences: Preferences;
      openAt: OpenAt;
    };

export type Capabilities = {
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

// Everything the viewer's callbacks share, which outlives renders.
export function newHost() {
  return {
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
  };
}

export type ReaderHost = ReturnType<typeof newHost>;

// The secondary toolbar of the PDF shown, as EmbedPDF names it: null in View, undefined while no
// laid-out PDF is shown.
export function activeToolbar(host: ReaderHost): string | null | undefined {
  const documentId = host.caps === null ? null : host.caps.documents.getActiveDocumentId();
  return documentId === null || host.caps === null || !host.laidOut.has(documentId)
    ? undefined
    : host.caps.ui.forDocument(documentId).getActiveToolbar("top", "secondary");
}
