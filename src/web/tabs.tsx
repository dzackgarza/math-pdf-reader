import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Tabs from "@radix-ui/react-tabs";
import { FileText, Library, Moon, X } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { MetadataEventSchema, OpenReaderSchema } from "../contract/capture";
import { AiPane, useAiPane } from "./AiPane";
import { onBucketEvent } from "./bucketEvents";
import ConfirmDialog, { type ConfirmRequest } from "./components/ConfirmDialog";
import { MENU_ITEM, MENU_PANEL } from "./components/ItemContextMenu";
import { keybindings, matchesShortcut } from "./keyboardShortcuts";
import { Reader } from "./reader/Reader";
import type { ReaderControl, ReaderProjection, TabEntry } from "./reader/readerHost";
import { type ItemMenu, type ReaderExtraction, ReaderTabsContext } from "./readerTabs";
import { showLibraryAddress, showReaderAddress } from "./windowAddress";
import { keepTabs, tabsToRestore } from "./windowTabs";

declare global {
  interface WindowEventMap {
    "pdf-bucket-quit": CustomEvent<{ waitUntil(settled: Promise<void>): void }>;
  }
}

const LIBRARY_TAB = "library";

const restoring = tabsToRestore();

function readerKey(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice("/read/".length));
}

const TAB_CLASSES =
  "flex h-8 min-w-0 items-center gap-2 rounded-t-md border border-b-0 px-3 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const TAB_STATE_CLASSES =
  "border-transparent text-muted hover:bg-ink/[0.04] hover:text-ink data-[state=active]:border-line data-[state=active]:bg-panel data-[state=active]:font-medium data-[state=active]:text-ink";

function TabMenu({
  itemMenu,
  itemKey,
  entries,
}: {
  itemMenu: RefObject<ItemMenu | null>;
  itemKey: string;
  entries: ReactNode;
}) {
  return (
    itemMenu.current?.(itemKey, entries) ?? (
      <ContextMenu.Content className={MENU_PANEL}>{entries}</ContextMenu.Content>
    )
  );
}

export function ReaderTabs({ children }: { children: ReactNode }) {
  const [projection, setProjection] = useState<ReaderProjection>({ tabs: [], active: null });
  const [libraryShown, setLibraryShown] = useState(true);
  const aiPane = useAiPane();
  const [extractionView, setView] = useState<ReaderExtraction | null>(null);
  const setExtractionView = useCallback((view: ReaderExtraction | null) => setView(() => view), []);
  const shown = libraryShown || projection.active === null ? LIBRARY_TAB : projection.active;
  const stateRef = useRef({ projection, shown });
  stateRef.current = { projection, shown };
  const pages = useRef(
    new Map<string, number>(
      (restoring?.tabs ?? []).flatMap(({ key, position }) =>
        position === null ? [] : [[key, position.pageNumber] as const],
      ),
    ),
  );
  useEffect(() => {
    if (shown === LIBRARY_TAB) {
      showLibraryAddress();
      window.dispatchEvent(new CustomEvent("bucket-stylus-mode", { detail: "inactive" }));
    } else {
      showReaderAddress(shown, pages.current.get(shown));
    }
  }, [shown]);
  const onPage = useCallback((key: string, page: number) => {
    pages.current.set(key, page);
    if (stateRef.current.shown === key) {
      showReaderAddress(key, page);
    }
  }, []);

  const [readerMounted, setReaderMounted] = useState(false);
  const control = useRef<ReaderControl | null>(null);
  const waiting = useRef<[string, string][]>([]);
  const restored = useRef(false);
  const onControl = useCallback((given: ReaderControl) => {
    control.current = given;
    if (restoring !== null && !restored.current) {
      restored.current = true;
      given.restore(restoring.tabs);
      if (restoring.shown !== null) {
        given.activate(restoring.shown);
      }
    }
    for (const [key, title] of waiting.current.splice(0)) {
      given.open(key, title);
    }
  }, []);

  useEffect(() => {
    if (restoring === null || restoring.tabs.length === 0) {
      return;
    }
    const root = document.documentElement;
    const mount = () => {
      if (root.dataset.theme === undefined) {
        return;
      }
      observer.disconnect();
      if (restoring.shown !== null) {
        setLibraryShown(false);
      }
      setReaderMounted(true);
    };
    const observer = new MutationObserver(mount);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    mount();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const leaving = () => {
      const current = control.current;
      if (current === null) {
        return;
      }
      const shownKey = stateRef.current.shown;
      keepTabs({
        tabs: current.saved(),
        shown: shownKey === LIBRARY_TAB ? null : shownKey,
        fromReaderReload: false,
      });
    };
    window.addEventListener("pagehide", leaving);
    return () => window.removeEventListener("pagehide", leaving);
  }, []);
  const reader = useCallback((): ReaderControl => {
    if (control.current === null) {
      throw new Error("the window's reader is not mounted");
    }
    return control.current;
  }, []);

  const itemMenu = useRef<ItemMenu | null>(null);
  const setItemMenu = useCallback((menu: ItemMenu | null) => {
    itemMenu.current = menu;
  }, []);

  const show = useCallback(
    (key: string) => {
      if (key === LIBRARY_TAB) {
        setLibraryShown(true);
        return;
      }
      reader().activate(key);
      setLibraryShown(false);
    },
    [reader],
  );

  const openReader = useCallback((key: string, title: string) => {
    setLibraryShown(false);
    setReaderMounted(true);
    if (control.current === null) {
      waiting.current.push([key, title]);
      return;
    }
    control.current.open(key, title);
  }, []);

  const closeReader = useCallback(
    (key: string) => (control.current === null ? Promise.resolve() : control.current.close(key)),
    [],
  );

  const [closeRequest, setCloseRequest] = useState<ConfirmRequest | null>(null);
  const close = useCallback(
    (key: string) => {
      closeReader(key).catch((error: Error) => {
        show(key);
        const title = stateRef.current.projection.tabs.find((tab) => tab.key === key)?.title ?? key;
        setCloseRequest({
          title: "Close without saving?",
          description: `${title}: ${error.message}`,
          confirmLabel: "Close Without Saving",
          onConfirm: () => reader().discard(key),
        });
      });
    },
    [closeReader, show, reader],
  );

  const sleep = useCallback(
    (key: string) => {
      reader()
        .sleep(key)
        .catch(() => show(key));
    },
    [reader, show],
  );

  useEffect(() => {
    const quitting = (event: WindowEventMap["pdf-bucket-quit"]) => {
      event.detail.waitUntil(
        control.current === null ? Promise.resolve() : control.current.settleAll(),
      );
    };
    window.addEventListener("pdf-bucket-quit", quitting);
    return () => window.removeEventListener("pdf-bucket-quit", quitting);
  }, []);

  useEffect(() => {
    const stepping = (step: 1 | -1) => {
      const { projection: current, shown: from } = stateRef.current;
      const order = [LIBRARY_TAB, ...current.tabs.map((tab) => tab.key)];
      const next = order.at((order.indexOf(from) + step) % order.length);
      if (next === undefined) {
        throw new Error("the tab row always holds the Library tab");
      }
      show(next);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[data-keybinding-recorder="true"]') !== null) {
        event.preventDefault();
        return;
      }
      const shortcuts = keybindings();
      if (matchesShortcut(event, shortcuts.closeTab)) {
        event.preventDefault();
        if (stateRef.current.shown !== LIBRARY_TAB) {
          close(stateRef.current.shown);
        }
      }
      if (matchesShortcut(event, shortcuts.nextTab)) {
        event.preventDefault();
        stepping(1);
      }
      if (matchesShortcut(event, shortcuts.previousTab)) {
        event.preventDefault();
        stepping(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [close, show]);

  useEffect(() => {
    return onBucketEvent("open-reader", (event) => {
      const { reader_url, title } = OpenReaderSchema.parse(JSON.parse(event.data));
      openReader(readerKey(reader_url), title);
    });
  }, [openReader]);

  useEffect(() => {
    return onBucketEvent("metadata", (event) => {
      const { key, outcome } = MetadataEventSchema.parse(JSON.parse(event.data));
      if (outcome.status === "resolved") {
        control.current?.retitle(key, outcome.title);
      }
    });
  }, []);

  const tabEntries = (tab: TabEntry) => (
    <>
      <ContextMenu.Item disabled={tab.asleep} onSelect={() => sleep(tab.key)} className={MENU_ITEM}>
        Sleep Tab
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => close(tab.key)} className={MENU_ITEM}>
        Close Tab
      </ContextMenu.Item>
    </>
  );

  return (
    <ReaderTabsContext.Provider
      value={{
        openReader,
        closeReader,
        libraryShown: shown === LIBRARY_TAB,
        setItemMenu,
        setExtractionView,
      }}
    >
      <Tabs.Root
        value={shown}
        onValueChange={show}
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
          {projection.tabs.map((tab) => (
            <ContextMenu.Root key={tab.key}>
              <ContextMenu.Trigger asChild>
                <div
                  data-tab-key={tab.key}
                  data-state={shown === tab.key ? "active" : "inactive"}
                  data-asleep={tab.asleep}
                  className={`group -mb-px flex w-56 min-w-24 shrink items-center rounded-t-md border border-b-0 ${
                    shown === tab.key ? "border-line bg-panel" : "border-transparent"
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
                    title="Close tab"
                    onClick={() => close(tab.key)}
                    className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-ink/[0.08] hover:text-ink"
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <TabMenu itemMenu={itemMenu} itemKey={tab.key} entries={tabEntries(tab)} />
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
        </Tabs.List>
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
          <Tabs.Content
            value={LIBRARY_TAB}
            forceMount
            className="absolute inset-0 data-[state=inactive]:invisible"
          >
            {children}
          </Tabs.Content>
          <div
            data-state={shown === LIBRARY_TAB ? "inactive" : "active"}
            className="absolute inset-0 data-[state=inactive]:invisible"
          >
            {readerMounted && (
              <Reader
                shown={shown !== LIBRARY_TAB}
                inTab
                onControl={onControl}
                onProjection={setProjection}
                onPage={onPage}
              />
            )}
          </div>
          </div>
          {shown !== LIBRARY_TAB && (
            <AiPane
              itemKey={shown}
              pane={aiPane.pane}
              onChange={aiPane.change}
              extraction={extractionView === null ? null : extractionView(shown)}
            />
          )}
        </div>
      </Tabs.Root>
      {closeRequest !== null && (
        <ConfirmDialog request={closeRequest} onClose={() => setCloseRequest(null)} />
      )}
    </ReaderTabsContext.Provider>
  );
}
