// What the bucket keeps for one PDF open in the reader's document manager, named by its item
// key (which is also its EmbedPDF document id): the stored bytes' entity tag, the save queue, a
// save conflict or failure, the reading session, the page last recorded, and the positions the
// reader jumped between.
//
// Saving (RFC 9110 conditional requests): a short pause after EmbedPDF commits an annotation
// change into the document, the export plugin writes this document with every annotation, and
// the PUT names the bytes it was made from in `If-Match`. The server keeps it while the stored
// file still holds those bytes (or only a metadata write followed them) and the new ones carry
// the item's provenance, and answers the new entity tag. Saves run one after another. When the
// stored PDF changed since it was loaded (412), the reader keeps showing the user's copy and
// offers to save it over the stored PDF or to discard it and load the stored PDF.
//
// Back and forward walk the positions the reader jumped between in this PDF (links, outline,
// thumbnails, search results, page entry), as PDF.js's PDFHistory does (web/pdf_history.js): a
// jump from A keeps the positions before the current one, then A; the place the jump leads to is
// stored when a step leaves it. A step back or forward is not itself a jump.
import type { ZoomLevel } from "@embedpdf/react-pdf-viewer";
import { MIN_PAGE_SECONDS, READER_IDLE_MINUTES } from "../../contract/library";
import { requestError } from "../useLibraryApi";
import { ReadingSession } from "./readingSession";

// Where a reader is in its PDF: the page at the viewport's top-left corner, that corner's place
// in the page's own coordinates (PDF points from the page's top-left, unscaled), and the zoom.
export type Position = {
  pageNumber: number;
  x: number;
  y: number;
  zoom: ZoomLevel;
};

// How long after an annotation change the reader saves, so a burst of changes is one save.
const SAVE_PAUSE_MS = 700;
// How long after a page change the reader records it as the item's last viewed page.
const RECORD_PAUSE_MS = 1000;

const ENTITY_TAG = /^"[0-9a-f]{64}"$/;

// The entity tag an answer carries (server/src/library.rs `entity_tag`).
export function entityTag(response: Response): string {
  const tag = response.headers.get("ETag");
  if (tag === null || !ENTITY_TAG.test(tag)) {
    throw new Error(`${response.url} answered without the stored PDF's entity tag (ETag: ${tag})`);
  }
  return tag;
}

// The positions the reader jumped between, and the one it shows: an index past the last position
// means the reader is past them all, where the last jump led.
export class Positions {
  private positions: Position[] = [];
  private index = 0;

  jumped(from: Position): void {
    this.positions = [...this.positions.slice(0, this.index), from];
    this.index = this.positions.length;
  }

  // The position a step of STEP (-1 back, 1 forward) from CURRENT shows, or null at either end.
  // CURRENT replaces the position the reader shows, or follows them all.
  step(step: -1 | 1, current: Position): Position | null {
    const position = this.positions[this.index + step];
    if (position === undefined) {
      return null;
    }
    this.positions[this.index] = current;
    this.index += step;
    return position;
  }

  canStep(step: -1 | 1): boolean {
    return this.positions[this.index + step] !== undefined;
  }
}

// What the reader shows over the PDF while it is the active one: the save state or a failure.
export type Status = { text: string; failed: boolean } | null;

export class DocumentStorage {
  page = 1;
  // The page the item's last viewed page names: the one the reader opened at, then each page
  // recorded. Only a change of page is recorded, so a PDF opened and left at page 1 stays unread.
  recordedPage = 1;
  failure: string | null = null;
  // True while the stored PDF changed since it was loaded and the reader holds an unsaved copy.
  conflict = false;
  status: Status = null;
  readonly history = new Positions();
  readonly session: ReadingSession;
  private pendingSave: ReturnType<typeof setTimeout> | null = null;
  private pendingRecord: ReturnType<typeof setTimeout> | null = null;
  private saves = Promise.resolve();
  // Saves started and not yet finished.
  private saving = 0;

  constructor(
    readonly key: string,
    private storedTag: string,
    // This document's bytes with every annotation, from EmbedPDF's export plugin.
    private readonly exported: () => Promise<ArrayBuffer>,
    // EmbedPDF has written every committed annotation edit of this document into it.
    private readonly committed: () => Promise<void>,
    // Something this storage shows changed.
    private readonly changed: () => void,
  ) {
    this.session = new ReadingSession(
      key,
      READER_IDLE_MINUTES * 60_000,
      MIN_PAGE_SECONDS * 1000,
      (message) => this.show({ text: message, failed: true }),
    );
  }

  show(status: Status): void {
    this.status = status;
    this.changed();
  }

  unsaved(): boolean {
    return this.pendingSave !== null || this.saving > 0 || this.conflict;
  }

  private put(bytes: ArrayBuffer) {
    return fetch(`/api/items/${encodeURIComponent(this.key)}/pdf`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
        "If-Match": this.storedTag,
      },
      body: bytes,
    });
  }

  private async save(): Promise<void> {
    console.info("reader PDF save", { key: this.key, stage: "start" });
    if (this.conflict) {
      return;
    }
    this.show({ text: "Saving…", failed: false });
    const response = await this.put(await this.exported());
    if (response.status === 412) {
      this.storedTag = entityTag(response);
      this.failure = "Not saved: the PDF changed elsewhere after it was opened.";
      this.conflict = true;
      this.show({ text: this.failure, failed: true });
      return;
    }
    if (!response.ok) {
      throw new Error(`Not saved: ${(await requestError(response)).message}`);
    }
    this.storedTag = entityTag(response);
    this.failure = null;
    this.show(null);
    console.info("reader PDF save", { key: this.key, stage: "complete" });
  }

  private startSave(): void {
    this.pendingSave = null;
    this.saving += 1;
    this.saves = this.saves
      .then(() => this.save())
      .catch((error: Error) => {
        this.failure = error.message;
        this.show({ text: error.message, failed: true });
      })
      .finally(() => {
        this.saving -= 1;
      });
  }

  // EmbedPDF committed an annotation change into this document.
  edited(): void {
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
    }
    this.pendingSave = setTimeout(() => this.startSave(), SAVE_PAUSE_MS);
  }

  // Sends the reading session and waits for every annotation to be saved, rejecting while a
  // save has failed or a save conflict is open.
  async settle(): Promise<void> {
    console.info("reader settle", { key: this.key, stage: "session" });
    await this.session.send(false);
    console.info("reader settle", { key: this.key, stage: "annotations" });
    await this.committed();
    console.info("reader settle", {
      key: this.key,
      stage: "saves",
      pendingSave: this.pendingSave !== null,
      saving: this.saving,
    });
    // The click or key that settles can itself commit an annotation (a deselected note), so a
    // save scheduled while one runs is started too, until none is left.
    while (this.pendingSave !== null || this.saving > 0) {
      if (this.pendingSave !== null) {
        clearTimeout(this.pendingSave);
        this.startSave();
      }
      await this.saves;
      console.info("reader settle", {
        key: this.key,
        stage: "save-complete",
        pendingSave: this.pendingSave !== null,
        saving: this.saving,
      });
    }
    console.info("reader settle", {
      key: this.key,
      stage: "complete",
      failure: this.failure,
      conflict: this.conflict,
    });
    if (this.failure !== null) {
      throw new Error(this.failure);
    }
    if (this.conflict) {
      throw new Error("a save conflict is open");
    }
  }

  // The copy the reader shows, with every change made since the refused save, replaces the
  // stored PDF.
  async keepMine(): Promise<void> {
    const response = await this.put(await this.exported());
    if (!response.ok) {
      this.show({
        text: `Not saved: ${(await requestError(response)).message}`,
        failed: true,
      });
      return;
    }
    this.storedTag = entityTag(response);
    this.failure = null;
    this.conflict = false;
    this.show(null);
  }

  pageChanged(pageNumber: number, totalPages: number, shown: boolean): void {
    this.page = pageNumber;
    this.session.pageChanged(pageNumber, shown);
    if (this.pendingRecord !== null) {
      clearTimeout(this.pendingRecord);
      this.pendingRecord = null;
    }
    if (pageNumber === this.recordedPage) {
      return;
    }
    this.pendingRecord = setTimeout(() => {
      this.recordedPage = pageNumber;
      fetch(`/api/items/${encodeURIComponent(this.key)}/reading`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: pageNumber, pages: totalPages }),
      })
        .then(async (response) => {
          if (!response.ok) {
            throw await requestError(response);
          }
        })
        .catch((error: Error) =>
          this.show({
            text: `Page not recorded: ${error.message}`,
            failed: true,
          }),
        );
    }, RECORD_PAUSE_MS);
  }

  // The document leaves the manager: its session reports and stops, and no save is left. A
  // page change waiting to be recorded is still recorded.
  dispose(): void {
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
    }
    void this.session.close();
  }
}
