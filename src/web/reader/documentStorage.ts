import { type ZoomLevel, ZoomMode } from "@embedpdf/react-pdf-viewer";
import {
  MIN_PAGE_SECONDS,
  READER_IDLE_MINUTES,
  ReadingRequestSchema,
  type Provenance,
  type RecordedZoom,
} from "../../contract/library";
import { ProvenanceSchema } from "../../contract/capture";
import { requestError } from "../useLibraryApi";
import { ReadingSession } from "./readingSession";

const ZOOM_MODES = {
  automatic: ZoomMode.Automatic,
  "fit-page": ZoomMode.FitPage,
  "fit-width": ZoomMode.FitWidth,
} as const;

export function viewerZoom(recorded: RecordedZoom): ZoomLevel {
  return typeof recorded === "number" ? recorded : ZOOM_MODES[recorded];
}

export type Position = {
  pageNumber: number;
  x: number;
  y: number;
  zoom: ZoomLevel;
};

const SAVE_PAUSE_MS = 700;
const RECORD_PAUSE_MS = 1000;

const ENTITY_TAG = /^"[0-9a-f]{64}"$/;

export function entityTag(response: Response): string {
  const tag = response.headers.get("ETag");
  if (tag === null || !ENTITY_TAG.test(tag)) {
    throw new Error(
      `${response.url} answered without the stored PDF's entity tag (ETag: ${tag})`,
    );
  }
  return tag;
}

export function pdfEdition(response: Response): Provenance {
  const encoded = response.headers.get("X-Pdf-Edition");
  if (encoded === null || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${response.url} answered without the PDF edition`);
  }
  const bytes = Uint8Array.from(
    atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
  return ProvenanceSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export class Positions {
  private positions: Position[] = [];
  private index = 0;

  jumped(from: Position): void {
    this.positions = [...this.positions.slice(0, this.index), from];
    this.index = this.positions.length;
  }

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

export type Status = { text: string; failed: boolean } | null;

export class DocumentStorage {
  page = 1;
  recordedPage = 1;
  recordedZoom: RecordedZoom = "automatic";
  private pages = 1;
  private zoom: RecordedZoom = "automatic";
  failure: string | null = null;
  conflict = false;
  status: Status = null;
  readonly history = new Positions();
  readonly session: ReadingSession;
  private pendingSave: ReturnType<typeof setTimeout> | null = null;
  private pendingRecord: ReturnType<typeof setTimeout> | null = null;
  private saves = Promise.resolve();
  private saving = 0;

  constructor(
    readonly key: string,
    private storedTag: string,
    private readonly edition: Provenance,
    private readonly exported: () => Promise<ArrayBuffer>,
    private readonly committed: () => Promise<void>,
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
    return (
      this.pendingSave !== null ||
      this.saving > 0 ||
      this.conflict ||
      this.failure !== null
    );
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
    if (this.conflict) {
      return;
    }
    await this.saveCopy();
  }

  private async saveCopy(): Promise<void> {
    console.info("reader PDF save", { key: this.key, stage: "start" });
    this.show({ text: "Saving…", failed: false });
    const response = await this.put(await this.exported());
    if (response.status === 412) {
      this.storedTag = entityTag(response);
      this.failure =
        "Not saved: the PDF changed elsewhere after it was opened.";
      this.conflict = true;
      this.show({ text: this.failure, failed: true });
      return;
    }
    if (!response.ok) {
      throw new Error(`Not saved: ${(await requestError(response)).message}`);
    }
    this.storedTag = entityTag(response);
    this.failure = null;
    this.conflict = false;
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

  edited(): void {
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
    }
    this.pendingSave = setTimeout(() => this.startSave(), SAVE_PAUSE_MS);
  }

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

  async keepMine(): Promise<void> {
    await this.committed();
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    await this.saves;
    await this.saveCopy();
  }

  opened(page: number, pages: number, zoom: RecordedZoom): void {
    this.page = page;
    this.recordedPage = page;
    this.pages = pages;
    this.zoom = zoom;
    this.recordedZoom = zoom;
  }

  pageChanged(pageNumber: number, totalPages: number, shown: boolean): void {
    this.page = pageNumber;
    this.pages = totalPages;
    this.session.pageChanged(pageNumber, shown);
    this.scheduleRecord();
  }

  zoomChanged(zoom: RecordedZoom): void {
    this.zoom = zoom;
    this.scheduleRecord();
  }

  private scheduleRecord(): void {
    if (this.pendingRecord !== null) {
      clearTimeout(this.pendingRecord);
      this.pendingRecord = null;
    }
    if (this.page === this.recordedPage && this.zoom === this.recordedZoom) {
      return;
    }
    this.pendingRecord = setTimeout(() => this.sendRecord(false), RECORD_PAUSE_MS);
  }

  leaving(): void {
    if (this.pendingRecord === null) {
      return;
    }
    clearTimeout(this.pendingRecord);
    this.sendRecord(true);
  }

  private sendRecord(keepalive: boolean): void {
    this.pendingRecord = null;
    this.recordedPage = this.page;
    this.recordedZoom = this.zoom;
    fetch(`/api/items/${encodeURIComponent(this.key)}/reading`, {
        method: "PUT",
        keepalive,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          ReadingRequestSchema.parse({
            page: this.page,
            pages: this.pages,
            zoom: this.zoom,
            edition: this.edition,
          }),
        ),
      })
        .then(async (response) => {
          if (!response.ok) {
            throw await requestError(response);
          }
        })
        .catch((error: Error) =>
          this.show({
            text: `Page and zoom not recorded: ${error.message}`,
            failed: true,
          }),
        );
  }

  dispose(): void {
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
    }
    void this.session.close();
  }
}
