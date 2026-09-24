// Which items a library view shows, what it is called, and the tag and topic counts.
import {
  type AdvancedSearchSettings,
  type BucketItem,
  collectionSubtree,
  type LibraryPayload,
} from "../server/libraryContract";
import { tagLabel } from "./format";
import { filterItems } from "./search";

export type LibraryView =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "unread" }
  | { kind: "recent" }
  | { kind: "offline" }
  | { kind: "missing" }
  | { kind: "collection"; id: string }
  | { kind: "tag"; tag: string }
  | { kind: "saved"; id: string };

export const ALL_ITEMS: LibraryView = { kind: "all" };

// A view whose collection or saved search no longer exists falls back to the whole library,
// so a reload after a deletion never leaves the table pointing at nothing.
export function reconcileView(payload: LibraryPayload, view: LibraryView): LibraryView {
  if (view.kind === "collection" && !payload.collections.some((c) => c.id === view.id)) {
    return ALL_ITEMS;
  }
  if (view.kind === "saved" && !payload.savedSearches.some((s) => s.id === view.id)) {
    return ALL_ITEMS;
  }
  return view;
}

// Whether an item can still be fetched from where it came from: offline when the last check
// found its PDF URL dead or changed and no mirror serving the captured bytes.
export type Availability = "cached" | "offline";

export function availability(item: BucketItem): Availability {
  const lost = item.sourceCheck.status === "dead" || item.sourceCheck.status === "changed";
  const mirrored = item.mirrors.some((mirror) => mirror.check.status === "accessible");
  return lost && !mirrored ? "offline" : "cached";
}

export function itemsInView(payload: LibraryPayload, view: LibraryView): BucketItem[] {
  switch (view.kind) {
    case "all":
      return payload.items;
    case "unfiled":
      return payload.items.filter((item) => item.collections.length === 0);
    case "unread":
      return payload.items.filter((item) => item.reading.status === "unread");
    case "offline":
      return payload.items.filter((item) => availability(item) === "offline");
    // Lost PDFs are not library items; the library shows them in their own list.
    case "missing":
      return [];
    case "recent": {
      const since = Date.now() - WEEK_MS;
      return payload.items.filter((item) => Date.parse(item.dateAdded) >= since);
    }
    case "collection": {
      const subtree = collectionSubtree(payload.collections, view.id);
      return payload.items.filter((item) => item.collections.some((id) => subtree.has(id)));
    }
    case "tag":
      return payload.items.filter((item) => item.tags.includes(view.tag));
    case "saved":
      return filterItems(payload.items, savedSearch(payload, view.id).search);
  }
}

function savedSearch(payload: LibraryPayload, id: string) {
  const found = payload.savedSearches.find((search) => search.id === id);
  if (found === undefined) {
    throw new Error(`no saved search has id ${id}`);
  }
  return found;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const FIXED_VIEW_NAMES = {
  all: "Library",
  unfiled: "Unfiled",
  unread: "Unread",
  recent: "Added This Week",
  offline: "Offline",
  missing: "Needs Re-fetch",
} as const;

// The library's quick filters, one at a time: the view each shows and its address.
export const QUICK_FILTERS = [
  { view: { kind: "unread" }, path: "/unread" },
  { view: { kind: "unfiled" }, path: "/unfiled" },
  { view: { kind: "recent" }, path: "/added-this-week" },
  { view: { kind: "offline" }, path: "/offline" },
  { view: { kind: "missing" }, path: "/needs-refetch" },
] as const satisfies { view: LibraryView; path: string }[];

export type QuickFilter = (typeof QUICK_FILTERS)[number];

export function quickFilterName(filter: QuickFilter): string {
  return FIXED_VIEW_NAMES[filter.view.kind];
}

export function quickFilterCount(payload: LibraryPayload, filter: QuickFilter): number {
  return filter.view.kind === "missing"
    ? payload.missing.length
    : itemsInView(payload, filter.view).length;
}

export function viewName(payload: LibraryPayload, view: LibraryView): string {
  if (view.kind === "collection") {
    const found = payload.collections.find((collection) => collection.id === view.id);
    if (found === undefined) {
      throw new Error(`no collection has id ${view.id}`);
    }
    return found.name;
  }
  if (view.kind === "tag") {
    return tagLabel(view.tag);
  }
  if (view.kind === "saved") {
    return savedSearch(payload, view.id).name;
  }
  return FIXED_VIEW_NAMES[view.kind];
}

export function visibleItems(
  payload: LibraryPayload,
  view: LibraryView,
  search: AdvancedSearchSettings,
): BucketItem[] {
  return filterItems(itemsInView(payload, view), search);
}

// Every tag (topics included) with the number of items carrying it, most used first.
export function tagCounts(items: BucketItem[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const tag of items.flatMap((item) => item.tags)) {
    const seen = counts.get(tag);
    counts.set(tag, seen === undefined ? 1 : seen + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
