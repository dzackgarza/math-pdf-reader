// The Timeline's reading of the stored sessions. Sessions of one PDF that open within
// MERGE_GAP_MS of the previous one's last reading form one entry (a PDF closed and reopened,
// or left for another paper and come back to); an entry read for less than the chosen
// minimum is left out. The pages and seconds are already filtered by the reader: only pages
// read for at least MIN_PAGE_SECONDS at a time, idle time excluded.
import type { ReadingSession } from "../contract/library";

export const MERGE_GAP_MS = 30 * 60 * 1000;

export type TimelineEntry = {
  key: string;
  item: ReadingSession["item"];
  openedAt: string;
  lastSeenAt: string;
  // Seconds read, over every page.
  seconds: number;
  // The pages read, ascending.
  pages: number[];
  // How many sessions the entry joins.
  sessions: number;
};

export function timelineEntries(sessions: ReadingSession[], minSeconds: number): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const latest = new Map<string, TimelineEntry>();
  const byOpening = [...sessions].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  for (const session of byOpening) {
    const seconds = session.pages.reduce((total, page) => total + page.seconds, 0);
    const pages = session.pages.map((page) => page.page);
    const previous = latest.get(session.key);
    const joins =
      previous !== undefined &&
      Date.parse(session.openedAt) - Date.parse(previous.lastSeenAt) <= MERGE_GAP_MS;
    if (previous !== undefined && joins) {
      previous.item = session.item;
      previous.lastSeenAt =
        Date.parse(session.lastSeenAt) > Date.parse(previous.lastSeenAt)
          ? session.lastSeenAt
          : previous.lastSeenAt;
      previous.seconds += seconds;
      previous.pages = [...new Set([...previous.pages, ...pages])].sort((a, b) => a - b);
      previous.sessions += 1;
      continue;
    }
    const entry: TimelineEntry = {
      key: session.key,
      item: session.item,
      openedAt: session.openedAt,
      lastSeenAt: session.lastSeenAt,
      seconds,
      pages: [...new Set(pages)].sort((a, b) => a - b),
      sessions: 1,
    };
    entries.push(entry);
    latest.set(session.key, entry);
  }
  return entries
    .filter((entry) => entry.seconds >= minSeconds)
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

// Ascending page numbers as ranges: 1, 2, 3, 7 reads "1–3, 7".
export function pageRanges(pages: number[]): string {
  const ranges: [number, number][] = [];
  for (const page of pages) {
    const last = ranges.at(-1);
    if (last !== undefined && page === last[1] + 1) {
      last[1] = page;
    } else {
      ranges.push([page, page]);
    }
  }
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(", ");
}
