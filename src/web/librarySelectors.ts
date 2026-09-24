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

export function itemsInView(payload: LibraryPayload, view: LibraryView): BucketItem[] {
  switch (view.kind) {
    case "all":
      return payload.items;
    case "unfiled":
      return payload.items.filter((item) => item.collections.length === 0);
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

const FIXED_VIEW_NAMES = { all: "Library", unfiled: "Unfiled" } as const;

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
