// The PDFs the reader holds: opening one into EmbedPDF's document manager, showing, closing,
// putting to sleep and waking it, and what the reader offers whoever shows it.
//
// Sleep: EmbedPDF's document manager has no suspend, so a PDF put to sleep settles its saves, is
// closed, and leaves a bookmark (its title, exact position and place among the tabs); waking it
// opens the stored PDF again at that position and place.

import { useCallback, useEffect } from "react";
import {
  type BucketItem,
  LibraryPayloadSchema,
  type Preferences,
} from "../../contract/library";
import { request, requestError } from "../useLibraryApi";
import { DocumentStorage, entityTag, type Position } from "./documentStorage";
import type {
  Bookmark,
  Capabilities,
  Held,
  OpenAt,
  ReaderControl,
  ReaderHost,
  ReaderProjection,
} from "./readerHost";

// How many PDFs stay open in the manager. Past it, the PDFs shown longest ago sleep, which frees
// their PDFium documents, and showing one opens it again where it was. Firefox's tab unloader
// picks the tabs it unloads the same way, by the time each was last shown
// (browser/components/tabbrowser/TabUnloader.sys.mjs).
const AWAKE_READERS = 5;

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

// What the reader's document operations read and announce.
type Context = {
  host: ReaderHost;
  caps: () => Capabilities;
  changed: () => void;
  projection: () => ReaderProjection;
  storageOf: (key: string) => DocumentStorage | null;
  placeOf: (key: string) => Position;
  setNightMode: (on: boolean) => void;
};

// KEY, whose bytes LOADED holds, opens in EmbedPDF's manager unless the reader stopped LOADING it.
async function openLoaded(
  context: Context,
  key: string,
  loading: Extract<Held, { status: "loading" }>,
  loaded: Loaded,
): Promise<void> {
  const { host, changed, projection } = context;
  if (host.held.get(key) !== loading) {
    return;
  }
  const { documents, exporter, annotations } = context.caps();
  const storage = new DocumentStorage(
    key,
    loaded.tag,
    () => exporter.forDocument(key).saveAsCopy().toPromise(),
    async () => {
      const scope = annotations.forDocument(key);
      console.error("reader annotation commit", {
        key,
        stage: "start",
        pending: scope.getState().hasPendingChanges,
      });
      await scope.commit().toPromise();
      console.error("reader annotation commit", {
        key,
        stage: "task-resolved",
        pending: scope.getState().hasPendingChanges,
      });
      // EmbedPDF writes an annotation edit into its document asynchronously, and raises the
      // edit's committed event (which schedules the save) before it clears hasPendingChanges.
      // Once that flag is clear, every edit made so far has scheduled its save.
      await new Promise<void>((resolve) => {
        if (!scope.getState().hasPendingChanges) {
          resolve();
          return;
        }
        const stop = scope.onStateChange((state) => {
          console.error("reader annotation state", {
            key,
            pending: state.hasPendingChanges,
          });
          if (!state.hasPendingChanges) {
            stop();
            resolve();
          }
        });
      });
      console.error("reader annotation commit", { key, stage: "complete" });
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
    context.setNightMode(host.nightMode);
  }
  console.error("reader document open", { key, stage: "opening" });
  const response = await documents
    .openDocumentBuffer({
      buffer: loaded.bytes,
      name: `${key}.pdf`,
      documentId: key,
      autoActivate: host.focus === key,
    })
    .toPromise();
  if (response.documentId !== key) {
    throw new Error(
      `EmbedPDF opened ${key} as document ${response.documentId}`,
    );
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
  console.error("reader document open", { key, stage: "waiting-for-task" });
  await response.task.toPromise();
  console.error("reader document open", { key, stage: "complete" });
  changed();
}

export function useDocuments(context: Context) {
  const { host, caps, changed, projection, storageOf, placeOf } = context;

  // The tab that takes KEY's place: the one after it, or the one before the last.
  const neighbour = useCallback(
    (key: string): string | null => {
      const tabs = projection().tabs;
      const index = tabs.findIndex((tab) => tab.key === key);
      const others = tabs.filter((tab) => tab.key !== key);
      const next = others[Math.min(index, others.length - 1)];
      return next === undefined ? null : next.key;
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
      const loading: Extract<Held, { status: "loading" }> = {
        status: "loading",
        openAt,
        index: bookmark === undefined ? null : bookmark.index,
      };
      host.held.set(key, loading);
      host.focus = key;
      changed();
      const ready = new Promise<void>((resolve) =>
        host.caps === null ? host.whenReady.push(resolve) : resolve(),
      );
      console.error("reader document requested", { key });
      ready
        .then(() => load(key))
        .then((loaded) => openLoaded(context, key, loading, loaded))
        .catch((error: Error) => {
          console.error("reader document open failed", {
            key,
            message: error.message,
          });
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
    [host, activate, changed, context],
  );

  // EmbedPDF closes KEY's PDF, and shows NEXT first when NEXT is open.
  const closeShown = useCallback(
    (key: string, next: string | null) => {
      const { documents } = caps();
      const shownNext = next === null ? undefined : host.held.get(next);
      if (next !== null && shownNext?.status === "open") {
        documents.setActiveDocument(next);
      }
      documents.closeDocument(key);
    },
    [host, caps],
  );

  // KEY, about to be shown, wakes when it sleeps.
  const wakeSleeping = useCallback(
    (key: string) => {
      const sleeping = host.bookmarks.get(key);
      if (sleeping !== undefined) {
        open(key, sleeping.title);
      }
    },
    [host, open],
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
        closeShown(key, next);
      }
      changed();
      if (next !== null) {
        wakeSleeping(next);
      }
    },
    [host, neighbour, changed, closeShown, wakeSleeping],
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
      console.error("reader document close", { key, stage: "settling" });
      if (host.bookmarks.delete(key)) {
        host.titles.delete(key);
        changed();
        return;
      }
      await storageOf(key)?.settle();
      console.error("reader document close", {
        key,
        stage: "settled",
        held: host.held.has(key),
      });
      if (host.held.has(key)) {
        remove(key, null);
        console.error("reader document close", { key, stage: "removed" });
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

  return { activate, open, remove, sleepReader, sleepDrowsy, close, reload };
}

// The reader offers ONCONTROL its operations on the PDFs it holds.
export function useControl(
  onControl: (control: ReaderControl) => void,
  host: ReaderHost,
  changed: () => void,
  documents: ReturnType<typeof useDocuments>,
) {
  const { open, activate, close, remove, sleepReader } = documents;
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
}

// The reading session of the PDF shown follows whether it is shown and the user's input; returns
// the handler that reports one input.
export function useReadingInput(
  shown: boolean,
  activeStorage: () => DocumentStorage | null,
  isShown: (key: string) => boolean,
  scopeShortcuts: () => void,
) {
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
    return () =>
      document.removeEventListener("visibilitychange", changedVisibility);
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

  return readingInput;
}
