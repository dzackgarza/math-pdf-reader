// The reader: one stored PDF in EmbedPDF (PDFium compiled to WebAssembly), under a bar with a
// Library link (only when the reader is not in a library tab), back and forward, the title, the
// save state, night mode and a button that copies the captured PDF link. The library's tabs
// (tabs.tsx) and the `/read/<key>` page (main.tsx) both show it.
//
// Saving (RFC 9110 conditional requests): the reader keeps the entity tag `/pdf/<key>.pdf`
// answered with, the stored bytes' SHA-256. A short pause after EmbedPDF commits an annotation
// change into the document, ExportPlugin.saveAsCopy writes the PDF with every annotation, and the
// reader PUTs it with `If-Match` naming the bytes it was made from. The server keeps it while
// the stored file still holds those bytes and the new ones carry the item's provenance, and
// answers the new entity tag. Saves run one after another. When the stored PDF changed since it
// was loaded (412), the reader keeps showing the user's copy and offers to save it over the
// stored PDF or to discard it and load the stored PDF.
//
// Back and forward walk the positions the reader jumped between in this PDF (links, outline,
// thumbnails, search results), as PDF.js's PDFHistory does (web/pdf_history.js): a jump from A
// to B keeps the positions up to the current one, then A, then B; a step back or forward is not
// itself a jump.

import pdfiumWasm from "@embedpdf/pdfium/pdfium.wasm?url";
import {
  AnnotationPlugin,
  type Command,
  CommandsPlugin,
  ExportPlugin,
  InteractionManagerPlugin,
  PDFViewer,
  type PDFViewerConfig,
  type PDFViewerRef,
  type PluginRegistry,
  ScrollPlugin,
  UIPlugin,
} from "@embedpdf/react-pdf-viewer";
import { ArrowLeft, ArrowRight, LibraryBig, Link, Moon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MetadataEventSchema } from "../../contract/capture";
import {
  type BucketItem,
  LIBRARY_VIEW_KEY,
  LibraryPayloadSchema,
  MIN_PAGE_SECONDS,
  type Preferences,
  READER_IDLE_MINUTES,
  ThemeSchema,
} from "../../contract/library";
import { onBucketEvent } from "../bucketEvents";
import { request, requestError } from "../useLibraryApi";
import { ReadingSession } from "./readingSession";

// What a reader offers whoever shows it: settle sends the reading session and waits for every
// annotation to be saved, rejecting while a save has failed or a save conflict is open; page is
// the page it shows.
export type ReaderControl = { settle: () => Promise<void>; page: () => number };

// How long after an annotation change the reader saves, so a burst of changes is one save.
const SAVE_PAUSE_MS = 700;
// How long after a page change the reader records it as the item's last viewed page.
const RECORD_PAUSE_MS = 1000;

const ENTITY_TAG = /^"[0-9a-f]{64}"$/;

// The bucket opens, closes, prints and redacts nothing from inside a reader.
const VIEWER_DISABLED = ["document", "redaction"];

// Night mode draws each page inverted, with hues turned back, so text is light on dark and
// highlights keep their colours. EmbedPDF draws a page in one box with a white background (the
// snippet's renderPage), holding a low-resolution image, a layer of sharp tiles and the
// annotation layers; the box is the one element inverted, since an inverted element inside it
// would turn back.
const NIGHT_PAGES = 'div[style*="transform-origin"][style*="background-color: rgb(255, 255, 255)"]';

// The entity tag an answer carries (server/src/library.rs `entity_tag`).
function entityTag(response: Response): string {
  const tag = response.headers.get("ETag");
  if (tag === null || !ENTITY_TAG.test(tag)) {
    throw new Error(`${response.url} answered without the stored PDF's entity tag (ETag: ${tag})`);
  }
  return tag;
}

function plugin<
  T extends
    | ExportPlugin
    | ScrollPlugin
    | AnnotationPlugin
    | CommandsPlugin
    | UIPlugin
    | InteractionManagerPlugin,
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

// The positions the reader jumped between, and the one it shows.
class Positions {
  private pages: number[] = [];
  private index = -1;

  jumped(from: number, to: number): void {
    this.pages = this.pages.slice(0, this.index + 1);
    if (this.pages.at(-1) !== from) {
      this.pages.push(from);
    }
    this.pages.push(to);
    this.index = this.pages.length - 1;
  }

  // The page a step of STEP (-1 back, 1 forward) shows, or null at either end.
  step(step: -1 | 1): number | null {
    const page = this.pages[this.index + step];
    if (page === undefined) {
      return null;
    }
    this.index += step;
    return page;
  }

  canStep(step: -1 | 1): boolean {
    return this.pages[this.index + step] !== undefined;
  }
}

type ReaderProps = {
  itemKey: string;
  // The page to open at; null opens at the page last viewed, or the first.
  openAtPage: number | null;
  shown: boolean;
  inTab: boolean;
  onControl?: (control: ReaderControl) => void;
  // Each page the reader shows.
  onPage?: (page: number) => void;
};

export function Reader(props: ReaderProps) {
  const { itemKey } = props;
  const [loaded, setLoaded] = useState<
    | { status: "loading" }
    | { status: "failed"; message: string }
    | { status: "ready"; value: Loaded }
  >({ status: "loading" });
  // Each load of the stored PDF (the first, and one after a conflict's copy is discarded).
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    setLoaded({ status: "loading" });
    load(itemKey).then(
      (value) => current && setLoaded({ status: "ready", value }),
      (error: Error) => current && setLoaded({ status: "failed", message: error.message }),
    );
    return () => {
      current = false;
    };
  }, [itemKey, generation]);
  if (loaded.status === "loading") {
    return <ReaderShell>{null}</ReaderShell>;
  }
  if (loaded.status === "failed") {
    return (
      <ReaderShell>
        <p role="alert" className="m-4 text-sm text-danger">
          The PDF could not be opened: {loaded.message}
        </p>
      </ReaderShell>
    );
  }
  return (
    <LoadedReader
      key={generation}
      {...props}
      loaded={loaded.value}
      reload={() => setGeneration((previous) => previous + 1)}
    />
  );
}

function ReaderShell({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col bg-surface text-ink">{children}</div>;
}

const BAR_BUTTON =
  "inline-flex h-8 w-8 flex-none items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent aria-pressed:bg-surface aria-pressed:text-accent";

function LoadedReader({
  itemKey,
  openAtPage,
  shown,
  inTab,
  onControl,
  onPage,
  loaded,
  reload,
}: ReaderProps & { loaded: Loaded; reload: () => void }) {
  const viewerRef = useRef<PDFViewerRef>(null);
  const [title, setTitle] = useState(loaded.item.title);
  const [nightMode, setNightMode] = useState(loaded.preferences.readerNightMode);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  // True while the stored PDF changed since it was loaded and the reader holds an unsaved copy.
  const [conflict, setConflict] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bounds, setBounds] = useState({ back: false, forward: false });

  const shownRef = useRef(shown);
  shownRef.current = shown;
  const isShown = () => shownRef.current && document.visibilityState === "visible";

  // Everything the viewer's callbacks share, which outlives renders.
  const state = useRef({
    page: 1,
    storedTag: loaded.tag,
    failure: null as string | null,
    conflict: false,
    pendingSave: null as ReturnType<typeof setTimeout> | null,
    pendingRecord: null as ReturnType<typeof setTimeout> | null,
    // The page the item's last viewed page names: the one the reader opened at, then each page
    // recorded. Only a change of page is recorded, so a PDF opened and left at page 1 stays unread.
    recordedPage: 1,
    saves: Promise.resolve(),
    // Saves started and not yet finished.
    saving: 0,
    positions: new Positions(),
    // True while the reader itself moves (opening at a page, back, forward), which is no jump.
    walking: false,
    exporter: null as ReturnType<ExportPlugin["provides"]> | null,
    scroll: null as ReturnType<ScrollPlugin["provides"]> | null,
    commands: null as ReturnType<CommandsPlugin["provides"]> | null,
  }).current;
  state.conflict = conflict;

  const showFailure = useCallback((text: string) => setStatus({ text, failed: true }), []);
  const session = useMemo(
    () =>
      new ReadingSession(
        itemKey,
        READER_IDLE_MINUTES * 60_000,
        MIN_PAGE_SECONDS * 1000,
        showFailure,
      ),
    [itemKey, showFailure],
  );
  useEffect(() => () => void session.close(), [session]);

  const put = (bytes: ArrayBuffer, tag: string) =>
    fetch(`/api/items/${encodeURIComponent(itemKey)}/pdf`, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "If-Match": tag },
      body: bytes,
    });

  const save = async () => {
    if (state.conflict || state.exporter === null) {
      return;
    }
    setStatus({ text: "Saving…", failed: false });
    const bytes = await state.exporter.saveAsCopy().toPromise();
    const response = await put(bytes, state.storedTag);
    if (response.status === 412) {
      state.storedTag = entityTag(response);
      state.failure = "Not saved: the PDF changed elsewhere after it was opened.";
      showFailure(state.failure);
      setConflict(true);
      return;
    }
    if (!response.ok) {
      throw new Error(`Not saved: ${(await requestError(response)).message}`);
    }
    state.storedTag = entityTag(response);
    state.failure = null;
    setStatus(null);
  };

  const startSave = () => {
    state.pendingSave = null;
    state.saving += 1;
    state.saves = state.saves
      .then(save)
      .catch((error: Error) => {
        state.failure = error.message;
        showFailure(error.message);
      })
      .finally(() => {
        state.saving -= 1;
      });
  };

  const settle = async () => {
    await session.send(false);
    // The click or key that settles can itself commit an annotation (a deselected note), so a
    // save scheduled while one runs is started too, until none is left.
    while (state.pendingSave !== null || state.saving > 0) {
      if (state.pendingSave !== null) {
        clearTimeout(state.pendingSave);
        startSave();
      }
      await state.saves;
    }
    if (state.conflict || state.failure !== null) {
      throw new Error(state.failure ?? "a save conflict is open");
    }
  };

  const walk = (step: -1 | 1) => {
    const page = state.positions.step(step);
    if (page === null || state.scroll === null) {
      return;
    }
    state.walking = true;
    state.scroll.scrollToPage({ pageNumber: page, behavior: "instant" });
    setBounds({ back: state.positions.canStep(-1), forward: state.positions.canStep(1) });
  };

  // EmbedPDF answers its keyboard shortcuts on the whole document (plugin-commands' keyboard
  // utility), so a hidden reader disables every category that holds a shortcut command, and the
  // keys reach the library or the reader shown.
  const scopeShortcuts = useCallback(() => {
    const commands = state.commands;
    if (commands === null) {
      return;
    }
    if (shownRef.current) {
      commands.setDisabledCategories(VIEWER_DISABLED);
      return;
    }
    const categories = [...commands.getAllShortcuts().values()].flatMap((id) => {
      const found = commands.resolve(id).categories;
      if (found === undefined || found.length === 0) {
        throw new Error(`EmbedPDF's shortcut command ${id} has no category to disable`);
      }
      return found;
    });
    commands.setDisabledCategories([...VIEWER_DISABLED, ...categories]);
  }, [state]);

  const onReady = (registry: PluginRegistry) => {
    state.commands = plugin<CommandsPlugin>(registry, CommandsPlugin.id);
    state.commands.registerCommand(DEFAULT_TOOL);
    scopeShortcuts();
    const scroll = plugin<ScrollPlugin>(registry, ScrollPlugin.id);
    const annotations = plugin<AnnotationPlugin>(registry, AnnotationPlugin.id);
    state.exporter = plugin<ExportPlugin>(registry, ExportPlugin.id);
    state.scroll = scroll;
    scroll.onLayoutReady(({ isInitial, totalPages }) => {
      if (!isInitial) {
        return;
      }
      const reading = loaded.item.reading;
      const page = openAtPage ?? (reading.status === "viewed" ? reading.page : 1);
      state.recordedPage = page;
      if (page > 1 && page <= totalPages) {
        state.walking = true;
        scroll.scrollToPage({ pageNumber: page, behavior: "instant" });
      }
      if (loaded.preferences.outlineOnOpen) {
        // EmbedPDF's left sidebar (`sidebar-panel`) holds the thumbnails and outline tabs, and
        // opens on its first tab whatever its `defaultTab` says, so the outline goes first.
        const ui = plugin<UIPlugin>(registry, UIPlugin.id);
        const sidebar = ui.getSchema().sidebars["sidebar-panel"];
        if (sidebar === undefined || sidebar.content.type !== "tabs") {
          throw new Error("EmbedPDF's sidebar-panel has no tabs");
        }
        const tabs = sidebar.content.tabs;
        if (!tabs.some((tab) => tab.id === "outline")) {
          throw new Error("EmbedPDF's sidebar-panel has no outline tab");
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
        ui.setActiveSidebar("left", "main", "sidebar-panel");
      }
      session.start(page, isShown());
    });
    scroll.onPageChangeState(({ state: change }) => {
      if (!change.isChanging) {
        state.walking = false;
        return;
      }
      if (!state.walking && change.fromPage !== change.targetPage) {
        state.positions.jumped(change.fromPage, change.targetPage);
        setBounds({ back: state.positions.canStep(-1), forward: state.positions.canStep(1) });
      }
    });
    scroll.onPageChange(({ pageNumber, totalPages }) => {
      state.page = pageNumber;
      onPage?.(pageNumber);
      session.pageChanged(pageNumber, isShown());
      if (state.pendingRecord !== null) {
        clearTimeout(state.pendingRecord);
        state.pendingRecord = null;
      }
      if (pageNumber === state.recordedPage) {
        return;
      }
      state.pendingRecord = setTimeout(() => {
        state.recordedPage = pageNumber;
        fetch(`/api/items/${encodeURIComponent(itemKey)}/reading`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: pageNumber, pages: totalPages }),
        })
          .then(async (response) => {
            if (!response.ok) {
              throw await requestError(response);
            }
          })
          .catch((error: Error) => showFailure(`Page not recorded: ${error.message}`));
      }, RECORD_PAUSE_MS);
    });
    annotations.onAnnotationEvent((event) => {
      if (event.type === "loaded" || !event.committed) {
        return;
      }
      if (state.pendingSave !== null) {
        clearTimeout(state.pendingSave);
      }
      state.pendingSave = setTimeout(startSave, SAVE_PAUSE_MS);
    });
    onControl?.({ settle, page: () => state.page });
  };

  // A reader shown again starts reading its page; one hidden ends its stretch and reports.
  useEffect(() => {
    if (shown) {
      session.start(state.page, document.visibilityState === "visible");
    } else {
      session.hidden();
    }
    scopeShortcuts();
  }, [shown, session, state, scopeShortcuts]);

  // Alt+← and Alt+→ walk back and forward, and any key is reading input, while the reader is
  // shown: EmbedPDF's viewer holds no focus of its own, so the keys arrive at the document, as
  // EmbedPDF's own shortcuts do.
  useEffect(() => {
    if (!shown) {
      return;
    }
    const pressed = (event: KeyboardEvent) => {
      session.input(state.page, isShown());
      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        walk(-1);
      }
      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        walk(1);
      }
    };
    document.addEventListener("keydown", pressed);
    return () => document.removeEventListener("keydown", pressed);
  });

  useEffect(() => {
    const root = viewerRef.current?.container?.shadowRoot;
    if (root === null || root === undefined) {
      throw new Error("the reader's viewer has no shadow root");
    }
    const sheet = document.createElement("style");
    sheet.textContent = nightMode ? `${NIGHT_PAGES} { filter: invert(1) hue-rotate(180deg); }` : "";
    root.append(sheet);
    return () => sheet.remove();
  }, [nightMode]);
  useEffect(() => {
    const changed = () => {
      if (isShown()) {
        session.start(state.page, true);
      } else {
        session.hidden();
      }
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  });

  useEffect(
    () =>
      onBucketEvent("metadata", (event) => {
        const { key, outcome } = MetadataEventSchema.parse(JSON.parse(event.data));
        if (key === itemKey && outcome.status === "resolved") {
          setTitle(outcome.title);
        }
      }),
    [itemKey],
  );

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
      if (state.pendingSave !== null || state.saving > 0) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [state]);

  const config = useMemo<PDFViewerConfig>(
    () => ({
      // The engine fetches it from a worker, where a path names nothing.
      wasmUrl: new URL(pdfiumWasm, window.location.href).href,
      tabBar: "never",
      theme: { preference: ThemeSchema.parse(document.documentElement.dataset.theme) },
      fonts: {
        ui: { family: "Inter, 'Segoe UI', system-ui, sans-serif", stylesheetUrl: null },
        signature: null,
      },
      disabledCategories: VIEWER_DISABLED,
      // EmbedPDF's viewer makes the hand tool the default on a touch device ('mobile'), which it
      // detects by `ontouchstart`, and WebKitGTK has it on every machine: a drag selects text.
      pan: { defaultMode: "never" },
      documentManager: {
        initialDocuments: [{ buffer: loaded.bytes.slice(0), name: `${itemKey}.pdf` }],
      },
    }),
    [loaded, itemKey],
  );

  const toggleNightMode = async () => {
    const library = await request(LibraryPayloadSchema, "PATCH", "/api/preferences", {
      readerNightMode: !nightMode,
    }).catch((error: Error) => {
      showFailure(`Night mode: ${error.message}`);
      return null;
    });
    if (library !== null) {
      setNightMode(library.preferences.readerNightMode);
    }
  };

  // The copy the reader shows, with every change made since the refused save, replaces the
  // stored PDF.
  const keepMine = async () => {
    if (state.exporter === null) {
      throw new Error("a save conflict opened before the reader's viewer was up");
    }
    const response = await put(await state.exporter.saveAsCopy().toPromise(), state.storedTag);
    if (!response.ok) {
      showFailure(`Not saved: ${(await requestError(response)).message}`);
      return;
    }
    state.storedTag = entityTag(response);
    state.failure = null;
    setStatus(null);
    setConflict(false);
  };

  const libraryView = sessionStorage.getItem(LIBRARY_VIEW_KEY);
  const libraryHref = libraryView === null ? "/" : `/${libraryView}`;

  return (
    <div
      className="flex h-full flex-col bg-surface text-ink"
      data-reader-key={itemKey}
      data-night-mode={nightMode}
      onPointerDown={() => session.input(state.page, isShown())}
      onPointerMove={() => session.input(state.page, isShown())}
      onWheel={() => session.input(state.page, isShown())}
    >
      <header className="flex min-w-0 items-center gap-1 border-b border-line bg-panel px-2 py-1">
        {!inTab && (
          <a
            id="library"
            href={libraryHref}
            aria-label="Library"
            title="Library"
            onClick={(event) => {
              event.preventDefault();
              settle().then(
                () => window.location.assign(libraryHref),
                (error: Error) => showFailure(error.message),
              );
            }}
            className="mr-1 inline-flex h-8 flex-none items-center gap-1.5 rounded-l-md border-r border-line pr-2.5 pl-2 text-[0.8125rem] font-medium text-muted no-underline hover:bg-surface hover:text-ink"
          >
            <LibraryBig aria-hidden className="h-[18px] w-[18px]" />
            <span>Library</span>
          </a>
        )}
        <button
          type="button"
          aria-label="Back"
          title="Back (Alt+←)"
          disabled={!bounds.back}
          onClick={() => walk(-1)}
          className={BAR_BUTTON}
        >
          <ArrowLeft aria-hidden className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward (Alt+→)"
          disabled={!bounds.forward}
          onClick={() => walk(1)}
          className={BAR_BUTTON}
        >
          <ArrowRight aria-hidden className="h-[18px] w-[18px]" />
        </button>
        <h1 title={title} className="mx-2 min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </h1>
        <span
          role="status"
          data-failed={status?.failed}
          className="flex-none text-xs text-muted data-[failed=true]:text-danger"
        >
          {status?.text}
        </span>
        <button
          type="button"
          aria-label="Night mode"
          title="Night mode"
          aria-pressed={nightMode}
          onClick={() => void toggleNightMode()}
          className={BAR_BUTTON}
        >
          <Moon aria-hidden className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          aria-label="Copy PDF link"
          title="Copy PDF link"
          data-copied={copied}
          onClick={() => {
            navigator.clipboard.writeText(loaded.item.provenance.pdf_url).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              (error: Error) => showFailure(`Copy link: ${error.message}`),
            );
          }}
          className={`${BAR_BUTTON} data-[copied=true]:text-accent`}
        >
          <Link aria-hidden className="h-[18px] w-[18px]" />
        </button>
      </header>
      {conflict && (
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
              keepMine().catch((error: Error) => showFailure(`Not saved: ${error.message}`));
            }}
            className="h-7 rounded-md border border-line px-2.5 text-ink hover:bg-surface"
          >
            Save my copy over it
          </button>
          <button
            type="button"
            onClick={reload}
            className="h-7 rounded-md border border-line px-2.5 text-ink hover:bg-surface"
          >
            Discard my copy
          </button>
        </div>
      )}
      <PDFViewer
        ref={viewerRef}
        config={config}
        onReady={onReady}
        className="reader-viewer min-h-0 flex-1"
      />
    </div>
  );
}
