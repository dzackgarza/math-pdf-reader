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
import type { BucketItem, Preferences, SavedTab } from "../../contract/library";
import type { DocumentStorage, Position } from "./documentStorage";

export type TabEntry = { key: string; title: string; asleep: boolean };

export type ReaderProjection = { tabs: TabEntry[]; active: string | null };

export type ReaderControl = {
  open: (key: string, title: string, page?: number) => void;
  activate: (key: string) => void;
  close: (key: string) => Promise<void>;
  discard: (key: string) => void;
  sleep: (key: string) => Promise<void>;
  retitle: (key: string, title: string) => void;
  settleAll: () => Promise<void>;
  saved: () => SavedTab[];
  restore: (tabs: SavedTab[]) => void;
};

export const PAGE_BOX = 'div[style*="transform-origin"][style*="background-color"]';

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

export type OpenAt = { position: Position } | { page: number } | null;

export type Bookmark = { title: string; position: Position | null; index: number };

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

export function newHost() {
  return {
    caps: null as Capabilities | null,
    held: new Map<string, Held>(),
    titles: new Map<string, string>(),
    bookmarks: new Map<string, Bookmark>(),
    recent: [] as string[],
    focus: null as string | null,
    moving: false,
    nightMode: false,
    whenReady: [] as (() => void)[],
    laidOut: new Set<string>(),
    parked: new Map<string, Position>(),
  };
}

export type ReaderHost = ReturnType<typeof newHost>;

export function activeToolbar(host: ReaderHost): string | null | undefined {
  const documentId = host.caps === null ? null : host.caps.documents.getActiveDocumentId();
  return documentId === null || host.caps === null || !host.laidOut.has(documentId)
    ? undefined
    : host.caps.ui.forDocument(documentId).getActiveToolbar("top", "secondary");
}
