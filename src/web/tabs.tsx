// The window's tabs: the Library tab, always first and never closed, and one tab per open PDF,
// which frames that PDF's reader page (server/templates/reader.html). Every tab stays loaded
// while another is shown, so a PDF keeps its view and the library its view and selection.
// Opening a PDF that has a tab shows that tab. A capture anywhere opens its PDF here too: the
// bucket's `open-reader` event (server/src/events.rs).
import * as Tabs from "@radix-ui/react-tabs";
import { FileText, Library, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { OpenReaderSchema } from "../contract/capture";
import { KEYBOARD_SHORTCUTS, matchesShortcut } from "./keyboardShortcuts";
import { ReaderTabsContext } from "./readerTabs";
import { readerPath } from "./routes";

declare global {
  interface Window {
    // Set by a reader page once its viewer is up: sends the reading session and waits for every
    // annotation to be saved. A tab is closed only after it settles.
    settleReader?: () => Promise<void>;
  }
}

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
}: {
  tab: ReaderTab;
  shown: boolean;
  onTitle: (title: string) => void;
  onLoad: (frame: HTMLIFrameElement) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
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

  const openReader = useCallback((key: string, title: string) => {
    setState((previous) => ({
      open: previous.open.some((tab) => tab.key === key)
        ? previous.open
        : [...previous.open, { key, title }],
      shown: key,
    }));
  }, []);

  const close = useCallback(async (key: string) => {
    await frames.current.get(key)?.contentWindow?.settleReader?.();
    frames.current.delete(key);
    setState((previous) => closing(previous, key));
  }, []);

  // One handler for the window and every reader frame, which receive their own keys.
  const shownRef = useRef(state.shown);
  shownRef.current = state.shown;
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (matchesShortcut(event, KEYBOARD_SHORTCUTS.closeTab)) {
        event.preventDefault();
        if (shownRef.current !== LIBRARY_TAB) {
          void close(shownRef.current);
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
    const events = new EventSource("/api/events");
    events.addEventListener("open-reader", (event: MessageEvent<string>) => {
      const { reader_url } = OpenReaderSchema.parse(JSON.parse(event.data));
      const key = readerKey(reader_url);
      openReader(key, key);
    });
    return () => events.close();
  }, [openReader]);

  const retitle = (key: string) => (title: string) =>
    setState((previous) => ({
      ...previous,
      open: previous.open.map((tab) => (tab.key === key ? { ...tab, title } : tab)),
    }));

  return (
    <ReaderTabsContext.Provider value={{ openReader, libraryShown: state.shown === LIBRARY_TAB }}>
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
                    void close(tab.key);
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
                onClick={() => void close(tab.key)}
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
              />
            </Tabs.Content>
          ))}
        </div>
      </Tabs.Root>
    </ReaderTabsContext.Provider>
  );
}
