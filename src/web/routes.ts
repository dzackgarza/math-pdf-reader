// The screens the window shows, addressed by the hash path (`/#/organization/tags/MMP`).
import { type LibraryView, QUICK_FILTERS } from "./librarySelectors";

export const ORGANIZATION_TABS = ["collections", "topics", "tags", "saved"] as const;

export type OrganizationTab = (typeof ORGANIZATION_TABS)[number];

export type Screen =
  | { kind: "library"; view: LibraryView }
  | { kind: "organization"; tab: OrganizationTab; entry: string | null }
  | { kind: "settings" }
  | { kind: "timeline" };

const LIBRARY_VIEWS: Record<string, LibraryView> = {
  "/": { kind: "all" },
  ...Object.fromEntries(QUICK_FILTERS.map((filter) => [filter.path, filter.view])),
};

function organizationTab(segment: string | undefined): OrganizationTab | null {
  const tab = ORGANIZATION_TABS.find((candidate) => candidate === segment);
  return tab === undefined ? null : tab;
}

// The screen at a path, or null for a path the window never links to.
export function screenAt(path: string): Screen | null {
  const view = LIBRARY_VIEWS[path];
  if (view !== undefined) {
    return { kind: "library", view };
  }
  if (path === "/settings") {
    return { kind: "settings" };
  }
  if (path === "/timeline") {
    return { kind: "timeline" };
  }
  const [, section, tabSegment, entry] = path.split("/");
  const tab = organizationTab(tabSegment);
  if (section !== "organization" || tab === null) {
    return null;
  }
  return {
    kind: "organization",
    tab,
    entry: entry === undefined ? null : decodeURIComponent(entry),
  };
}

// The reader page of a stored PDF (server/src/reader.rs), which a reader tab frames.
export function readerPath(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

export function organizationPath(tab: OrganizationTab, entry?: string): string {
  return entry === undefined
    ? `/organization/${tab}`
    : `/organization/${tab}/${encodeURIComponent(entry)}`;
}

export function entryView(tab: OrganizationTab, entry: string): LibraryView {
  switch (tab) {
    case "collections":
      return { kind: "collection", id: entry };
    case "topics":
    case "tags":
      return { kind: "tag", tag: entry };
    case "saved":
      return { kind: "saved", id: entry };
  }
}
