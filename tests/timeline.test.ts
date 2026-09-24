// The timeline's reading of stored sessions: reopenings of one PDF close together form one
// entry, short entries are filtered, and page lists read as ranges.
import { expect, test } from "bun:test";
import type { ReadingSession } from "../src/server/libraryContract";
import { pageRanges, timelineEntries } from "../src/web/timeline";

const item = (title: string) => ({
  title,
  authors: ["Maryna Viazovska"],
  year: 2017,
  abstract: null,
  sourceUrl: "https://annals.math.princeton.edu/2017/185-3/p07",
});

let counter = 0;
function session(
  key: string,
  openedAt: string,
  lastSeenAt: string,
  pages: [number, number][],
): ReadingSession {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    key,
    openedAt,
    lastSeenAt,
    pages: pages.map(([page, seconds]) => ({ page, seconds })),
    item: item(`Paper ${key}`),
  };
}

test("reopenings of one PDF within half an hour form one entry; a later reading is its own", () => {
  const sessions = [
    session("packing", "2026-09-25T09:00:00Z", "2026-09-25T09:20:00Z", [[1, 300], [2, 600]]),
    // A glance at another paper between the two readings.
    session("lattices", "2026-09-25T09:22:00Z", "2026-09-25T09:25:00Z", [[4, 120]]),
    session("packing", "2026-09-25T09:40:00Z", "2026-09-25T10:00:00Z", [[2, 60], [5, 900]]),
    session("packing", "2026-09-25T13:00:00Z", "2026-09-25T13:10:00Z", [[9, 400]]),
  ];

  const entries = timelineEntries(sessions, 30);

  // Latest reading first.
  expect(entries.map((entry) => [entry.key, entry.openedAt, entry.lastSeenAt])).toEqual([
    ["packing", "2026-09-25T13:00:00Z", "2026-09-25T13:10:00Z"],
    ["packing", "2026-09-25T09:00:00Z", "2026-09-25T10:00:00Z"],
    ["lattices", "2026-09-25T09:22:00Z", "2026-09-25T09:25:00Z"],
  ]);
  const merged = entries[1];
  expect(merged?.pages).toEqual([1, 2, 5]);
  expect(merged?.seconds).toBe(300 + 600 + 60 + 900);
  expect(merged?.sessions).toBe(2);
});

test("an entry read for less than the minimum is left out", () => {
  const sessions = [
    session("glance", "2026-09-25T09:00:00Z", "2026-09-25T09:00:30Z", [[1, 20]]),
    session("reading", "2026-09-25T10:00:00Z", "2026-09-25T10:30:00Z", [[3, 1500]]),
  ];

  expect(timelineEntries(sessions, 30).map((entry) => entry.key)).toEqual(["reading"]);
  expect(timelineEntries(sessions, 5).map((entry) => entry.key)).toEqual(["reading", "glance"]);
});

test("pages read as ranges", () => {
  expect(pageRanges([1, 2, 3, 7, 9, 10])).toBe("1–3, 7, 9–10");
  expect(pageRanges([12])).toBe("12");
});
