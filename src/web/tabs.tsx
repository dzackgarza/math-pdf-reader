// The window's tabs: the Library tab, always first and never closed, and one tab per open PDF,
// which frames that PDF's reader page (server/templates/reader.html). Every tab stays loaded
// while another is shown, so a PDF keeps its view and the library its view and selection.
// Opening a PDF that has a tab shows that tab. A capture anywhere opens its PDF here too: the
// bucket's `open-reader` event (server/src/events.rs).
import * as Tabs from "@radix-ui/react-tabs";
import { FileText, Library, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { OpenReaderSchema } from "../contract/capture";
import { onBucketEvent } from "./bucketEvents";
import { KEYBOARD_SHORTCUTS, matchesShortcut } from "./keyboardShortcuts";
import { ReaderTabsContext } from "./readerTabs";
import { readerPath } from "./routes";

// What a reader page offers once its viewer is up (server/templates/reader.html): settle sends
// the reading session and waits for every annotation to be saved, rejecting while a save has
// failed or a save conflict is open.
type ReaderControl = { settle: () => Promise<void> };

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

// What the tab strip knows of a tab's reader: still loading (its viewer is not up, so it holds
// nothing unsaved), or ready, with its control.
type ReaderState = { status: "loading" } | { status: "ready"; control: ReaderControl };

const LIBRARY_TAB = "library";

type ReaderTab = { key: string; title: string };

type TabsState = { open: ReaderTab[]; shown: string };

// The key of the item a reader URL shows.
function readerKey(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice("/read/".length));
}

// The tab shown after closing KEY when it was shown: the one to its right, else to its left,
// else the Library tab.
function closing(state: TabsState, key: string): TabsState {
  const index = state.open.findIndex((tab) => tab.key === key);
  const open = state.open.filter((tab) => tab.key !== key);
  if (state.shown !== key) {
    return { ...state, open };
  }
  const neighbour = index < open.length ? open[index] : open[index - 1];
  return { open, shown: neighbour === undefined ? LIBRARY_TAB : neighbour.key };
}

// The tab Ctrl+Tab (STEP 1) or Ctrl+Shift+Tab (STEP -1) shows, wrapping around.
function stepping(state: TabsState, step: 1 | -1): TabsState {
  const order = [LIBRARY_TAB, ...state.open.map((tab) => tab.key)];
  const shown = order.at((order.indexOf(state.shown) + step) % order.length);
  if (shown === undefined) {
    throw new Error("the tab row always holds the Library tab");
  }
  return { ...state, shown };
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
      src={readerPath(tab.key)}
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
  const [state, setState] = useState<TabsState>({ open: [], shown: LIBRARY_TAB });
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const readers = useRef(new Map<string, ReaderState>());

  const openReader = useCallback((key: string, title: string) => {
    if (!readers.current.has(key)) {
      readers.current.set(key, { status: "loading" });
    }
    setState((previous) => ({
      open: previous.open.some((tab) => tab.key === key)
        ? previous.open
        : [...previous.open, { key, title }],
      shown: key,
    }));
  }, []);

  const readerReady = useCallback(
    (key: string) => (control: ReaderControl) => {
      readers.current.set(key, { status: "ready", control });
    },
    [],
  );

  const closeReader = useCallback(async (key: string) => {
    const reader = readers.current.get(key);
    if (reader === undefined) {
      return;
    }
    if (reader.status === "ready") {
      await reader.control.settle();
    }
    readers.current.delete(key);
    frames.current.delete(key);
    setState((previous) => closing(previous, key));
  }, []);

  // A tab whose reader cannot settle stays open and is shown: its reader names the failure.
  const close = useCallback(
    (key: string) => {
      closeReader(key).catch(() => setState((previous) => ({ ...previous, shown: key })));
    },
    [closeReader],
  );

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

  const retitle = (key: string) => (title: string) =>
    setState((previous) => ({
      ...previous,
      open: previous.open.map((tab) => (tab.key === key ? { ...tab, title } : tab)),
    }));

  return (
    <ReaderTabsContext.Provider
      value={{ openReader, closeReader, libraryShown: state.shown === LIBRARY_TAB }}
    >
      <Tabs.Root
        value={state.shown}
        onValueChange={(shown) => setState((previous) => ({ ...previous, shown }))}
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
            <div
              key={tab.key}
              data-tab-key={tab.key}
              data-state={state.shown === tab.key ? "active" : "inactive"}
              className={`group -mb-px flex w-56 min-w-24 shrink items-center rounded-t-md border border-b-0 ${
                state.shown === tab.key ? "border-line bg-panel" : "border-transparent"
              }`}
            >
              <Tabs.Trigger
                value={tab.key}
                title={tab.title}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    close(tab.key);
                  }
                }}
                className={`${TAB_CLASSES} flex-1 border-transparent pr-1 text-muted group-hover:text-ink data-[state=active]:font-medium data-[state=active]:text-ink`}
              >
                <FileText aria-hidden className="h-4 w-4 shrink-0" />
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
              <ReaderFrame
                tab={tab}
                shown={state.shown === tab.key}
                onTitle={retitle(tab.key)}
                onLoad={frameLoaded(tab.key)}
                onReady={readerReady(tab.key)}
              />
            </Tabs.Content>
          ))}
        </div>
      </Tabs.Root>
    </ReaderTabsContext.Provider>
  );
}
