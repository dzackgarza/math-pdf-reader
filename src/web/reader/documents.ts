import { useCallback, useEffect } from "react";
import {
  type BucketItem,
  LibraryPayloadSchema,
  type Preferences,
  type SavedTab,
} from "../../contract/library";
import { request, requestError } from "../useLibraryApi";
import {
  DocumentStorage,
  entityTag,
  pdfEdition,
  type Position,
  viewerZoom,
} from "./documentStorage";
import type {
  Bookmark,
  Capabilities,
  Held,
  OpenAt,
  ReaderControl,
  ReaderHost,
  ReaderProjection,
} from "./readerHost";

const AWAKE_READERS = 5;

type Loaded = {
  item: BucketItem;
  preferences: Preferences;
  bytes: ArrayBuffer;
  tag: string;
  edition: BucketItem["provenance"];
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
    edition: pdfEdition(response),
  };
}

type Context = {
  host: ReaderHost;
  caps: () => Capabilities;
  changed: () => void;
  projection: () => ReaderProjection;
  storageOf: (key: string) => DocumentStorage | null;
  placeOf: (key: string) => Position;
  setNightMode: (on: boolean) => void;
};

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
    loaded.edition,
    () => exporter.forDocument(key).saveAsCopy().toPromise(),
    async () => {
      const scope = annotations.forDocument(key);
      console.info("reader annotation commit", {
        key,
        stage: "start",
        pending: scope.getState().hasPendingChanges,
      });
      await scope.commit().toPromise();
      console.info("reader annotation commit", {
        key,
        stage: "task-resolved",
        pending: scope.getState().hasPendingChanges,
      });
      await new Promise<void>((resolve) => {
        if (!scope.getState().hasPendingChanges) {
          resolve();
          return;
        }
        const stop = scope.onStateChange((state) => {
          console.info("reader annotation state", {
            key,
            pending: state.hasPendingChanges,
          });
          if (!state.hasPendingChanges) {
            stop();
            resolve();
          }
        });
      });
      console.info("reader annotation commit", { key, stage: "complete" });
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
  console.info("reader document open", { key, stage: "opening" });
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
  console.info("reader document open", { key, stage: "waiting-for-task" });
  await response.task.toPromise();
  console.info("reader document open", { key, stage: "complete" });
  changed();
}

export function useDocuments(context: Context) {
  const { host, caps, changed, projection, storageOf, placeOf } = context;

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
        bookmark !== undefined && bookmark.position !== null
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
      console.info("reader document requested", { key });
      ready
        .then(() => load(key))
        .then((loaded) => openLoaded(context, key, loading, loaded))
        .catch((error: Error) => {
          console.info("reader document open failed", {
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

  const wakeSleeping = useCallback(
    (key: string) => {
      const sleeping = host.bookmarks.get(key);
      if (sleeping !== undefined) {
        open(key, sleeping.title);
      }
    },
    [host, open],
  );

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

  const sleepDrowsy = useCallback(() => {
    for (const key of host.recent.slice(AWAKE_READERS)) {
      sleepReader(key, true).catch(() => undefined);
    }
  }, [host, sleepReader]);

  const close = useCallback(
    async (key: string) => {
      console.info("reader document close", { key, stage: "settling" });
      if (host.bookmarks.delete(key)) {
        host.titles.delete(key);
        changed();
        return;
      }
      await storageOf(key)?.settle();
      console.info("reader document close", {
        key,
        stage: "settled",
        held: host.held.has(key),
      });
      if (host.held.has(key)) {
        remove(key, null);
        console.info("reader document close", { key, stage: "removed" });
      }
    },
    [host, storageOf, remove, changed],
  );

  const reload = useCallback(
    (key: string) => {
      const title = host.titles.get(key) ?? key;
      const index = projection().tabs.findIndex((tab) => tab.key === key);
      const position = placeOf(key);
      host.focus = null;
      remove(key, { title, position, index });
      open(key, title);
    },
    [host, projection, remove, placeOf, open],
  );

  const saved = useCallback(
    (): SavedTab[] =>
      projection().tabs.map((tab) => {
        const bookmark = host.bookmarks.get(tab.key);
        const held = host.held.get(tab.key);
        const position =
          bookmark !== undefined
            ? bookmark.position
            : held?.status === "open" && host.laidOut.has(tab.key)
              ? placeOf(tab.key)
              : held?.status === "loading" && held.openAt !== null && "position" in held.openAt
                ? held.openAt.position
                : null;
        return { key: tab.key, title: tab.title, position };
      }),
    [host, projection, placeOf],
  );

  const restore = useCallback(
    (tabs: SavedTab[]) => {
      tabs.forEach(({ key, title, position }, index) => {
        if (host.held.has(key) || host.bookmarks.has(key)) {
          return;
        }
        host.titles.set(key, title);
        host.bookmarks.set(key, {
          title,
          position: position === null ? null : { ...position, zoom: viewerZoom(position.zoom) },
          index,
        });
      });
      changed();
    },
    [host, changed],
  );

  return { activate, open, remove, sleepReader, sleepDrowsy, close, reload, saved, restore };
}

export function useControl(
  onControl: (control: ReaderControl) => void,
  host: ReaderHost,
  changed: () => void,
  documents: ReturnType<typeof useDocuments>,
) {
  const { open, activate, close, remove, sleepReader, saved, restore } = documents;
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
      saved,
      restore,
    });
  }, [onControl, open, activate, close, remove, sleepReader, saved, restore, changed, host]);

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

export function useReadingInput(
  shown: boolean,
  activeStorage: () => DocumentStorage | null,
  isShown: (key: string) => boolean,
  scopeShortcuts: () => void,
) {
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
