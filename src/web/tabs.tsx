// The window's tabs: the Library tab, always first and never closed, and one tab per open PDF,
// which frames that PDF's reader page (server/templates/reader.html). The library and the
// AWAKE_READERS PDF tabs shown last stay loaded while another tab is shown, so each keeps its
// view (and the library its selection); the other PDF tabs sleep, and so does a tab put to sleep
// from its menu. A tab that sleeps holds no reader and loads it again at the same view when shown.
// Opening a PDF that has a tab shows that tab. A capture anywhere opens its PDF here too: the
// bucket's `open-reader` event (server/src/events.rs); the title Retrieve metadata gives the PDF
// afterwards (`metadata`) retitles its tab and its reader page, whose title and citation tags a
// Zotero Connector reads.
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Tabs from "@radix-ui/react-tabs";
import { FileText, Library, Moon, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { MetadataEventSchema, OpenReaderSchema } from "../contract/capture";
import { onBucketEvent } from "./bucketEvents";
import { MENU_ITEM, MENU_PANEL } from "./components/ItemContextMenu";
import { KEYBOARD_SHORTCUTS, matchesShortcut } from "./keyboardShortcuts";
import { ReaderTabsContext } from "./readerTabs";
import { readerPath } from "./routes";

// What a reader page offers once its viewer is up (server/templates/reader.html): settle sends
// the reading session and waits for every annotation to be saved, rejecting while a save has
// failed or a save conflict is open; refresh reloads the page's title and citation tags from the
// server and gives the title.
type ReaderControl = { settle: () => Promise<void>; refresh: () => Promise<string> };

declare global {
  interface Window {
    // Set by a reader page just before it dispatches `reader-ready` on its frame element.
    readerControl: ReaderControl | undefined;
  }
  interface WindowEventMap {
    // The desktop app's tray Quit (desktop/src-tauri/src/follow-open-events.js): the app quits
    // once every promise handed to waitUntil settles, and asks first when one rejects.
    "pdf-bucket-quit": CustomEvent<{ waitUntil(settled: Promise<void>): void }>;
  }
}

// A reader page shows why its refresh or its settling failed; its tab stays as it is.
const shownInReader = () => undefined;

// What the tab strip knows of a tab's reader: still loading (its viewer is not up, so it holds
// nothing unsaved), and stale when its item was retitled meanwhile; or ready, with its control.
type ReaderState =
  | { status: "loading"; stale: boolean }
  | { status: "ready"; control: ReaderControl };

const LIBRARY_TAB = "library";

// How many PDF tabs keep their reader loaded. Past it, the tabs shown longest ago sleep: their
// frame is dropped, which frees its PDF.js viewer and worker, and showing one loads it again at
// the view it had. Firefox's tab unloader picks the tabs it unloads the same way, by the time
// each was last shown (browser/components/tabbrowser/TabUnloader.sys.mjs).
const AWAKE_READERS = 5;

// A PDF tab: SRC is the reader page its frame loads, which a tab put to sleep keeps with the view
// its reader had (the reader writes its page and zoom into its address).
type ReaderTab = { key: string; title: string; src: string; asleep: boolean };

// RECENT holds the keys of the PDF tabs, the one shown last first.
type TabsState = { open: ReaderTab[]; shown: string; recent: string[] };

// The key of the item a reader URL shows.
function readerKey(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice("/read/".length));
}

// Shows KEY's tab, waking it when it sleeps.
function showing(state: TabsState, key: string): TabsState {
  return {
    open: state.open.map((tab) => (tab.key === key ? { ...tab, asleep: false } : tab)),
    shown: key,
    recent:
      key === LIBRARY_TAB ? state.recent : [key, ...state.recent.filter((other) => other !== key)],
  };
}

// The tab shown in place of KEY's: the one to its right, else to its left, else the Library tab.
function neighbour(state: TabsState, key: string): string {
  const index = state.open.findIndex((tab) => tab.key === key);
  const others = state.open.filter((tab) => tab.key !== key);
  return (others[index] ?? others[index - 1])?.key ?? LIBRARY_TAB;
}

function closing(state: TabsState, key: string): TabsState {
  const closed = {
    open: state.open.filter((tab) => tab.key !== key),
    shown: state.shown,
    recent: state.recent.filter((other) => other !== key),
  };
  return state.shown === key ? showing(closed, neighbour(state, key)) : closed;
}

// KEY's tab asleep with the reader page SRC; when it was shown, its neighbour is shown instead.
function sleeping(state: TabsState, key: string, src: string): TabsState {
  const asleep = {
    ...state,
    open: state.open.map((tab) => (tab.key === key ? { ...tab, src, asleep: true } : tab)),
  };
  return state.shown === key ? showing(asleep, neighbour(state, key)) : asleep;
}

// The awake PDF tabs past the AWAKE_READERS shown last. The tab shown is never among them.
function drowsy(state: TabsState): string[] {
  const awake = new Set(state.open.filter((tab) => !tab.asleep).map((tab) => tab.key));
  return state.recent.filter((key) => awake.has(key)).slice(AWAKE_READERS);
}

// The tab Ctrl+Tab (STEP 1) or Ctrl+Shift+Tab (STEP -1) shows, wrapping around.
function stepping(state: TabsState, step: 1 | -1): TabsState {
  const order = [LIBRARY_TAB, ...state.open.map((tab) => tab.key)];
  const shown = order.at((order.indexOf(state.shown) + step) % order.length);
  if (shown === undefined) {
    throw new Error("the tab row always holds the Library tab");
  }
  return showing(state, shown);
}

const TAB_CLASSES =
  "flex h-8 min-w-0 items-center gap-2 rounded-t-md border border-b-0 px-3 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const TAB_STATE_CLASSES =
  "border-transparent text-muted hover:bg-ink/[0.04] hover:text-ink data-[state=active]:border-line data-[state=active]:bg-panel data-[state=active]:font-medium data-[state=active]:text-ink";

function ReaderFrame({
  tab,
  shown,
  onTitle,
  onLoad,
  onReady,
}: {
  tab: ReaderTab;
  shown: boolean;
  onTitle: (title: string) => void;
  onLoad: (frame: HTMLIFrameElement) => void;
  onReady: (control: ReaderControl) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const element = frame.current;
    if (element === null) {
      throw new Error(`the tab of ${tab.key} has no frame`);
    }
    const ready = () => {
      const control = element.contentWindow?.readerControl;
      if (control === undefined) {
        throw new Error(`the reader of ${tab.key} announced itself without its control`);
      }
      onReady(control);
    };
    element.addEventListener("reader-ready", ready);
    return () => element.removeEventListener("reader-ready", ready);
  }, [tab.key, onReady]);
  // A frame's document stays "visible" while its tab is hidden, so the reader page is told to
  // look again (it reads its frame's own visibility), and a shown tab takes the keyboard.
  useEffect(() => {
    const reader = frame.current?.contentWindow;
    reader?.document.dispatchEvent(new Event("visibilitychange"));
    if (shown) {
      reader?.focus();
    }
  }, [shown]);
  return (
    <iframe
      ref={frame}
      src={tab.src}
      title={tab.title}
      data-reader-key={tab.key}
      className="block h-full w-full border-0 bg-surface"
      onLoad={(event) => {
        const loaded = event.currentTarget;
        if (loaded.contentDocument === null) {
          throw new Error(`the tab of ${tab.key} frames a page of another origin`);
        }
        onTitle(loaded.contentDocument.title);
        onLoad(loaded);
      }}
    />
  );
}

export function ReaderTabs({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TabsState>({ open: [], shown: LIBRARY_TAB, recent: [] });
  const stateRef = useRef(state);
  stateRef.current = state;
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const readers = useRef(new Map<string, ReaderState>());
  // The tabs whose reader is settling before it sleeps.
  const settling = useRef(new Set<string>());

  const openReader = useCallback((key: string, title: string) => {
    setState((previous) =>
      showing(
        previous.open.some((tab) => tab.key === key)
          ? previous
          : {
              ...previous,
              open: [...previous.open, { key, title, src: readerPath(key), asleep: false }],
            },
        key,
      ),
    );
  }, []);

  // A tab opened or woken frames a reader that is loading.
  useEffect(() => {
    for (const tab of state.open) {
      if (!tab.asleep && !readers.current.has(tab.key)) {
        readers.current.set(tab.key, { status: "loading", stale: false });
      }
    }
  }, [state.open]);

  const retitle = useCallback(
    (key: string) => (title: string) =>
      setState((previous) => ({
        ...previous,
        open: previous.open.map((tab) => (tab.key === key ? { ...tab, title } : tab)),
      })),
    [],
  );

  const readerReady = useCallback(
    (key: string) => (control: ReaderControl) => {
      const previous = readers.current.get(key);
      readers.current.set(key, { status: "ready", control });
      if (previous?.status === "loading" && previous.stale) {
        control.refresh().then(retitle(key), shownInReader);
      }
    },
    [retitle],
  );

  // A loading reader that is stale gets its title from refresh once ready, never from its page.
  const pageTitled = (key: string) => (title: string) => {
    const reader = readers.current.get(key);
    if (reader?.status === "loading" && reader.stale) {
      return;
    }
    retitle(key)(title);
  };

  // A sleeping tab has no reader to settle.
  const closeReader = useCallback(async (key: string) => {
    const reader = readers.current.get(key);
    if (reader?.status === "ready") {
      await reader.control.settle();
    }
    readers.current.delete(key);
    frames.current.delete(key);
    setState((previous) => closing(previous, key));
  }, []);

  // A tab whose reader cannot settle stays open and is shown: its reader names the failure.
  const close = useCallback(
    (key: string) => {
      closeReader(key).catch(() => setState((previous) => showing(previous, key)));
    },
    [closeReader],
  );

  // Settles KEY's reader, then drops its frame, keeping the view it shows. A sleep the tab row
  // chose (AUTOMATIC) is called off when the tab was shown again meanwhile.
  const sleepReader = useCallback(async (key: string, automatic: boolean) => {
    if (settling.current.has(key)) {
      return;
    }
    settling.current.add(key);
    try {
      const reader = readers.current.get(key);
      if (reader?.status === "ready") {
        await reader.control.settle();
      }
    } finally {
      settling.current.delete(key);
    }
    if (automatic && !drowsy(stateRef.current).includes(key)) {
      return;
    }
    const page = frames.current.get(key)?.contentWindow?.location;
    readers.current.delete(key);
    frames.current.delete(key);
    setState((previous) => {
      const tab = previous.open.find((open) => open.key === key);
      if (tab === undefined) {
        return previous;
      }
      const src = page === undefined ? tab.src : page.pathname + page.search + page.hash;
      return sleeping(previous, key, src);
    });
  }, []);

  // A reader that cannot settle stays awake and is shown: it names the failure.
  const sleep = useCallback(
    (key: string) => {
      sleepReader(key, false).catch(() => setState((previous) => showing(previous, key)));
    },
    [sleepReader],
  );

  // The readers past AWAKE_READERS sleep. One that cannot settle stays awake and says why when
  // shown; the next change of tabs tries it again.
  useEffect(() => {
    for (const key of drowsy(state)) {
      sleepReader(key, true).catch(shownInReader);
    }
  }, [state, sleepReader]);

  // Quitting waits for every open reader to settle; one that cannot rejects the quit's wait.
  useEffect(() => {
    const quitting = (event: WindowEventMap["pdf-bucket-quit"]) => {
      const settling = [...readers.current.values()].map((reader) =>
        reader.status === "ready" ? reader.control.settle() : Promise.resolve(),
      );
      event.detail.waitUntil(Promise.all(settling).then(() => undefined));
    };
    window.addEventListener("pdf-bucket-quit", quitting);
    return () => window.removeEventListener("pdf-bucket-quit", quitting);
  }, []);

  // One handler for the window and every reader frame, which receive their own keys.
  const shownRef = useRef(state.shown);
  shownRef.current = state.shown;
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (matchesShortcut(event, KEYBOARD_SHORTCUTS.closeTab)) {
        event.preventDefault();
        if (shownRef.current !== LIBRARY_TAB) {
          close(shownRef.current);
        }
      }
      if (matchesShortcut(event, KEYBOARD_SHORTCUTS.nextTab)) {
        event.preventDefault();
        setState((previous) => stepping(previous, 1));
      }
      if (matchesShortcut(event, KEYBOARD_SHORTCUTS.previousTab)) {
        event.preventDefault();
        setState((previous) => stepping(previous, -1));
      }
    },
    [close],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);
  // A reader page and the PDF.js viewer it frames are same-origin frames with their own keys.
  const frameLoaded = (key: string) => (frame: HTMLIFrameElement) => {
    frames.current.set(key, frame);
    const reader = frame.contentWindow;
    if (reader === null) {
      return;
    }
    for (const target of [reader, ...Array.from({ length: reader.length }, (_, i) => reader[i])]) {
      target?.addEventListener("keydown", onKeyDown);
    }
  };

  useEffect(() => {
    return onBucketEvent("open-reader", (event) => {
      const { reader_url, title } = OpenReaderSchema.parse(JSON.parse(event.data));
      openReader(readerKey(reader_url), title);
    });
  }, [openReader]);

  useEffect(() => {
    return onBucketEvent("metadata", (event) => {
      const { key, outcome } = MetadataEventSchema.parse(JSON.parse(event.data));
      if (outcome.status !== "resolved") {
        return;
      }
      retitle(key)(outcome.title);
      const reader = readers.current.get(key);
      if (reader?.status === "ready") {
        reader.control.refresh().then(retitle(key), shownInReader);
      }
      if (reader?.status === "loading") {
        readers.current.set(key, { status: "loading", stale: true });
      }
    });
  }, [retitle]);

  return (
    <ReaderTabsContext.Provider
      value={{ openReader, closeReader, libraryShown: state.shown === LIBRARY_TAB }}
    >
      <Tabs.Root
        value={state.shown}
        onValueChange={(shown) => setState((previous) => showing(previous, shown))}
        activationMode="manual"
        className="flex h-full flex-col"
      >
        <Tabs.List
          aria-label="Open tabs"
          className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-surface px-2 pt-1.5"
        >
          <Tabs.Trigger
            value={LIBRARY_TAB}
            className={`${TAB_CLASSES} ${TAB_STATE_CLASSES} -mb-px`}
          >
            <Library aria-hidden className="h-4 w-4 shrink-0" />
            Library
          </Tabs.Trigger>
          {state.open.map((tab) => (
            <ContextMenu.Root key={tab.key}>
              <ContextMenu.Trigger asChild>
                <div
                  data-tab-key={tab.key}
                  data-state={state.shown === tab.key ? "active" : "inactive"}
                  data-asleep={tab.asleep}
                  className={`group -mb-px flex w-56 min-w-24 shrink items-center rounded-t-md border border-b-0 ${
                    state.shown === tab.key ? "border-line bg-panel" : "border-transparent"
                  }`}
                >
                  <Tabs.Trigger
                    value={tab.key}
                    title={tab.asleep ? `${tab.title} (asleep)` : tab.title}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        close(tab.key);
                      }
                    }}
                    className={`${TAB_CLASSES} flex-1 border-transparent pr-1 text-muted group-hover:text-ink data-[state=active]:font-medium data-[state=active]:text-ink`}
                  >
                    {tab.asleep ? (
                      <Moon aria-label="Asleep" className="h-4 w-4 shrink-0" />
                    ) : (
                      <FileText aria-hidden className="h-4 w-4 shrink-0" />
                    )}
                    <span className="truncate">{tab.title}</span>
                  </Tabs.Trigger>
                  <button
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    title="Close (Ctrl+W)"
                    onClick={() => close(tab.key)}
                    className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-ink/[0.08] hover:text-ink"
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className={MENU_PANEL}>
                  <ContextMenu.Item
                    disabled={tab.asleep}
                    onSelect={() => sleep(tab.key)}
                    className={MENU_ITEM}
                  >
                    Sleep Tab
                  </ContextMenu.Item>
                  <ContextMenu.Item onSelect={() => close(tab.key)} className={MENU_ITEM}>
                    Close Tab
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
        </Tabs.List>
        {/* Every tab fills the same box and a hidden one is only invisible: PDF.js lays out its
            pages from its frame's size, and a frame under display: none has none, so a PDF
            opened while another tab shows would stay blank. */}
        <div className="relative min-h-0 flex-1">
          <Tabs.Content
            value={LIBRARY_TAB}
            forceMount
            className="absolute inset-0 data-[state=inactive]:invisible"
          >
            {children}
          </Tabs.Content>
          {state.open.map((tab) => (
            <Tabs.Content
              key={tab.key}
              value={tab.key}
              forceMount
              className="absolute inset-0 data-[state=inactive]:invisible"
            >
              {!tab.asleep && (
                <ReaderFrame
                  tab={tab}
                  shown={state.shown === tab.key}
                  onTitle={pageTitled(tab.key)}
                  onLoad={frameLoaded(tab.key)}
                  onReady={readerReady(tab.key)}
                />
              )}
            </Tabs.Content>
          ))}
        </div>
      </Tabs.Root>
    </ReaderTabsContext.Provider>
  );
}
