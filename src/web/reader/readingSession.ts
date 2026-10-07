// A reading session: how long each page of one PDF was read while its reader was open.
//
// A stretch on one page counts once it lasts MIN_PAGE_SECONDS; it ends when the page changes,
// when the reader is hidden, or IDLE_MINUTES after the last input (pointer, wheel, key), and a
// new one starts with the next input. The session (opening time, last moment read, seconds per
// page) goes to /api/reading-sessions every 30 seconds, on each page change, when the reader is
// hidden, and when it closes; nothing is sent until a page is read.
import type { z } from "zod";
import { ReadingSessionReportSchema } from "../../contract/library";
import { requestError } from "../useLibraryApi";

const REPORT_EVERY_MS = 30_000;

type Stretch = { page: number; since: number };

export class ReadingSession {
  private readonly id = crypto.randomUUID();
  private readonly openedAt = new Date().toISOString();
  private readonly readMs = new Map<number, number>();
  private stretch: Stretch | null = null;
  private lastInput = Date.now();
  private lastRead: number | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly key: string,
    private readonly idleMs: number,
    private readonly minPageMs: number,
    private readonly onFailure: (message: string) => void,
  ) {
    this.timer = setInterval(() => this.sendShowingFailure(), REPORT_EVERY_MS);
  }

  private readingUntil(): number {
    return Math.min(Date.now(), this.lastInput + this.idleMs);
  }

  private stretchMs(): number {
    return this.stretch === null ? 0 : this.readingUntil() - this.stretch.since;
  }

  private endStretch(): void {
    if (this.stretch !== null && this.stretchMs() >= this.minPageMs) {
      const { page } = this.stretch;
      this.readMs.set(page, (this.readMs.get(page) ?? 0) + this.stretchMs());
      this.lastRead = this.readingUntil();
    }
    this.stretch = null;
  }

  // Reading PAGE starts now; SHOWN is false while the reader is hidden, when nothing is read.
  start(page: number, shown: boolean): void {
    this.endStretch();
    this.stretch = shown ? { page, since: Date.now() } : null;
  }

  // An input on the reader; after an idle spell it starts a new stretch on PAGE.
  input(page: number, shown: boolean): void {
    if (Date.now() - this.lastInput > this.idleMs) {
      this.endStretch();
      this.lastInput = Date.now();
      this.start(page, shown);
      return;
    }
    this.lastInput = Date.now();
  }

  pageChanged(page: number, shown: boolean): void {
    this.start(page, shown);
    this.sendShowingFailure();
  }

  hidden(): void {
    this.endStretch();
    this.send(true).catch((error: Error) =>
      this.onFailure(`Reading not recorded: ${error.message}`),
    );
  }

  private report(): z.infer<typeof ReadingSessionReportSchema> | null {
    const pages = new Map(this.readMs);
    let until = this.lastRead;
    if (this.stretch !== null && this.stretchMs() >= this.minPageMs) {
      const { page } = this.stretch;
      pages.set(page, (pages.get(page) ?? 0) + this.stretchMs());
      until = this.readingUntil();
    }
    if (pages.size === 0 || until === null) {
      return null;
    }
    return ReadingSessionReportSchema.parse({
      id: this.id,
      key: this.key,
      openedAt: this.openedAt,
      lastSeenAt: new Date(until).toISOString(),
      pages: [...pages].map(([page, ms]) => ({ page, seconds: Math.round(ms / 1000) })),
    });
  }

  // Sends the session; KEEPALIVE lets the request outlive a page that is being left.
  async send(keepalive: boolean): Promise<void> {
    const report = this.report();
    if (report === null) {
      return;
    }
    const response = await fetch("/api/reading-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive,
    });
    if (!response.ok) {
      throw await requestError(response);
    }
  }

  private sendShowingFailure(): void {
    this.send(false).catch((error: Error) =>
      this.onFailure(`Reading not recorded: ${error.message}`),
    );
  }

  // Sends the session one last time and stops reporting.
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.send(true);
  }
}
