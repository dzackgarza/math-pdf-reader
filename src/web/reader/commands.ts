// The reader's buttons in EmbedPDF's toolbar (withReaderButtons) and their keys: Library, Back,
// Forward, Night mode and Copy PDF link. Each acts on the document its command runs for.

import type { Command } from "@embedpdf/react-pdf-viewer";
import { useCallback, useRef } from "react";
import { LIBRARY_VIEW_KEY, LibraryPayloadSchema } from "../../contract/library";
import { request } from "../useLibraryApi";
import type { DocumentStorage, Position } from "./documentStorage";
import type { ReaderHost } from "./readerHost";

// What the reader's status says after Copy PDF link, and for how long.
const COPIED = "PDF link copied";
const COPIED_SHOWN_MS = 1500;

type Context = {
  host: ReaderHost;
  storageOf: (key: string) => DocumentStorage | null;
  positionOf: (key: string) => Position;
  restore: (key: string, position: Position) => void;
  scopeShortcuts: () => void;
  setNightMode: (on: boolean) => void;
};

// EmbedPDF keeps the commands registered at onReady; each runs the current render's action,
// which the returned reference holds.
export function useReaderCommands(context: Context) {
  const { host, storageOf, positionOf, restore, scopeShortcuts, setNightMode } = context;

  const walk = useCallback(
    (key: string, step: -1 | 1) => {
      const position = storageOf(key)?.history.step(step, positionOf(key));
      if (position === null || position === undefined) {
        return;
      }
      restore(key, position);
      scopeShortcuts();
    },
    [storageOf, positionOf, restore, scopeShortcuts],
  );

  // Whether KEY's history holds a place STEP away; a PDF still loading has no history yet.
  const canWalk = (key: string, step: -1 | 1) => {
    const storage = storageOf(key);
    return storage !== null && storage.history.canStep(step);
  };

  const toggleNightMode = async (key: string) => {
    const library = await request(LibraryPayloadSchema, "PATCH", "/api/preferences", {
      readerNightMode: !host.nightMode,
    }).catch((error: Error) => {
      storageOf(key)?.show({ text: `Night mode: ${error.message}`, failed: true });
      return null;
    });
    if (library !== null) {
      setNightMode(library.preferences.readerNightMode);
      host.nightMode = library.preferences.readerNightMode;
      scopeShortcuts();
    }
  };

  const libraryView = sessionStorage.getItem(LIBRARY_VIEW_KEY);
  const libraryHref = libraryView === null ? "/" : `/${libraryView}`;

  const readerCommands: Command[] = [
    {
      id: "bucket:library",
      label: "Library",
      icon: "bucket-library",
      // Leaving waits until the reading session is reported and every annotation saved.
      action: ({ documentId }) => {
        const storage = storageOf(documentId);
        (storage === null ? Promise.resolve() : storage.settle()).then(
          () => window.location.assign(libraryHref),
          (error: Error) => storage?.show({ text: error.message, failed: true }),
        );
      },
    },
    {
      id: "bucket:back",
      label: "Back (Alt+←)",
      icon: "bucket-back",
      shortcuts: ["Alt+ArrowLeft"],
      categories: ["navigation", "navigation-history"],
      disabled: ({ documentId }) => !canWalk(documentId, -1),
      action: ({ documentId }) => walk(documentId, -1),
    },
    {
      id: "bucket:forward",
      label: "Forward (Alt+→)",
      icon: "bucket-forward",
      shortcuts: ["Alt+ArrowRight"],
      categories: ["navigation", "navigation-history"],
      disabled: ({ documentId }) => !canWalk(documentId, 1),
      action: ({ documentId }) => walk(documentId, 1),
    },
    {
      id: "bucket:night-mode",
      label: "Night mode",
      icon: "bucket-night-mode",
      active: () => host.nightMode,
      action: ({ documentId }) => void toggleNightMode(documentId),
    },
    {
      id: "bucket:copy-link",
      label: "Copy PDF link",
      icon: "bucket-copy-link",
      action: ({ documentId }) => {
        const held = host.held.get(documentId);
        if (held?.status !== "open") {
          throw new Error(`Copy PDF link ran for ${documentId}, which is not open`);
        }
        navigator.clipboard.writeText(held.item.provenance.pdf_url).then(
          () => {
            held.storage.show({ text: COPIED, failed: false });
            setTimeout(() => {
              if (held.storage.status?.text === COPIED) {
                held.storage.show(null);
              }
            }, COPIED_SHOWN_MS);
          },
          (error: Error) =>
            held.storage.show({ text: `Copy link: ${error.message}`, failed: true }),
        );
      },
    },
  ];
  const commandsRef = useRef(readerCommands);
  commandsRef.current = readerCommands;
  return commandsRef;
}
