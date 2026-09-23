import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Search,
  Shapes,
  Tag,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  type Collection,
  type LibraryPayload,
  type SavedSearch,
  SEARCH_FIELDS,
} from "../../server/libraryContract";
import { isTopic, tagLabel } from "../format";
import { itemsInView, tagCounts, viewName } from "../librarySelectors";
import { entryView, ORGANIZATION_TABS, type OrganizationTab, organizationPath } from "../routes";
import { SEARCH_FIELD_LABELS } from "../search";

export type OrganizationActions = {
  newSubcollection: (parent: Collection) => void;
  renameCollection: (collection: Collection) => void;
  deleteCollection: (collection: Collection) => void;
  deleteSavedSearch: (search: SavedSearch) => void;
};

type OrganizationScreenProps = {
  payload: LibraryPayload;
  tab: OrganizationTab;
  entry: string | null;
  actions: OrganizationActions;
  table: ReactNode;
};

const TAB_LABELS: Record<OrganizationTab, string> = {
  collections: "Collections",
  topics: "Topics",
  tags: "Tags",
  saved: "Saved Searches",
};

const EMPTY_TEXT: Record<OrganizationTab, string> = {
  collections: "No collections yet. New Collection creates one; add PDFs to it from their details.",
  topics: "No topics yet. Add a topic to a PDF from its details.",
  tags: "No tags yet. Add a tag to a PDF from its details.",
  saved: "No saved searches yet. Type a search above and choose Save Search.",
};

function entryClasses(selected: boolean): string {
  return `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${
    selected ? "bg-accent-soft font-semibold text-accent" : "hover:bg-surface"
  }`;
}

function Count({ value }: { value: number }) {
  return (
    <span className="ml-auto pl-3 text-xs text-muted tabular-nums">{value.toLocaleString()}</span>
  );
}

function CollectionTree({ payload, entry }: { payload: LibraryPayload; entry: string | null }) {
  const renderNode = (collection: Collection, depth: number): ReactNode => {
    const children = payload.collections.filter(
      (candidate) => candidate.parentId === collection.id,
    );
    const selected = collection.id === entry;
    const count = itemsInView(payload, { kind: "collection", id: collection.id }).length;
    return (
      <li key={collection.id}>
        <Link
          href={organizationPath("collections", collection.id)}
          className={entryClasses(selected)}
          style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
        >
          {selected ? (
            <FolderOpen aria-hidden className="h-4 w-4 shrink-0 text-accent" />
          ) : (
            <Folder aria-hidden className="h-4 w-4 shrink-0 text-accent" />
          )}
          <span className="truncate">{collection.name}</span>
          <Count value={count} />
        </Link>
        {children.length > 0 && <ul>{children.map((child) => renderNode(child, depth + 1))}</ul>}
      </li>
    );
  };
  const roots = payload.collections
    .filter((collection) => collection.parentId === undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] items-start gap-x-4">
      {roots.map((root) => renderNode(root, 0))}
    </ul>
  );
}

function TagList({
  tags,
  tab,
  entry,
}: {
  tags: [string, number][];
  tab: OrganizationTab;
  entry: string | null;
}) {
  const Icon = tab === "topics" ? Shapes : Tag;
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1">
      {tags.map(([tag, count]) => (
        <li key={tag}>
          <Link href={organizationPath(tab, tag)} className={entryClasses(tag === entry)}>
            <Icon
              aria-hidden
              className={`h-4 w-4 shrink-0 ${tab === "topics" ? "text-topic" : "text-accent"}`}
            />
            <span className="truncate">{tagLabel(tag)}</span>
            <Count value={count} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function searchSummary(search: SavedSearch): string {
  const fields = SEARCH_FIELDS.filter((field) => search.search.searchFields[field]).map(
    (field) => SEARCH_FIELD_LABELS[field],
  );
  const words = search.search.matchType === "all" ? "all words of" : "any word of";
  return `Matches ${words} “${search.search.query}” in ${fields.join(", ")}`;
}

function SavedSearchList({ payload, entry }: { payload: LibraryPayload; entry: string | null }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-1">
      {payload.savedSearches.map((search) => (
        <li key={search.id}>
          <Link
            href={organizationPath("saved", search.id)}
            className={entryClasses(search.id === entry)}
          >
            <Search aria-hidden className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0">
              <span className="block truncate">{search.name}</span>
              <span className="block truncate text-xs font-normal text-muted">
                {searchSummary(search)}
              </span>
            </span>
            <Count value={itemsInView(payload, { kind: "saved", id: search.id }).length} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

const ACTION_CLASSES =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium hover:bg-surface";

function CollectionActions({
  collection,
  actions,
}: {
  collection: Collection;
  actions: OrganizationActions;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => actions.newSubcollection(collection)}
        className={ACTION_CLASSES}
      >
        <FolderPlus className="h-4 w-4" /> New Subcollection
      </button>
      <button
        type="button"
        onClick={() => actions.renameCollection(collection)}
        className={ACTION_CLASSES}
      >
        <Pencil className="h-4 w-4" /> Rename
      </button>
      <button
        type="button"
        onClick={() => actions.deleteCollection(collection)}
        className={ACTION_CLASSES}
      >
        <Trash2 className="h-4 w-4" /> Delete
      </button>
    </>
  );
}

function EntryHeader({
  payload,
  tab,
  entry,
  actions,
}: Omit<OrganizationScreenProps, "table"> & { entry: string }) {
  const view = entryView(tab, entry);
  const count = itemsInView(payload, view).length;
  const collection = payload.collections.find((candidate) => candidate.id === entry);
  const parent = payload.collections.find((candidate) => candidate.id === collection?.parentId);
  const saved = payload.savedSearches.find((candidate) => candidate.id === entry);
  const summary = saved === undefined ? "" : ` · ${searchSummary(saved)}`;

  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-line bg-white px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-1.5 text-lg font-semibold">
          {parent !== undefined && (
            <>
              <span className="font-normal text-muted">{parent.name}</span>
              <ChevronRight aria-hidden className="h-4 w-4 text-faint" />
            </>
          )}
          <span className="truncate">{viewName(payload, view)}</span>
        </h2>
        <p className="text-sm text-muted">
          {count.toLocaleString()} {count === 1 ? "PDF" : "PDFs"}
          {summary}
        </p>
      </div>
      {collection !== undefined && <CollectionActions collection={collection} actions={actions} />}
      {saved !== undefined && (
        <button
          type="button"
          onClick={() => actions.deleteSavedSearch(saved)}
          className={ACTION_CLASSES}
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      )}
    </div>
  );
}

export default function OrganizationScreen(props: OrganizationScreenProps) {
  const { payload, tab, entry, table } = props;
  const tags = tagCounts(payload.items).filter(([tag]) => isTopic(tag) === (tab === "topics"));
  const entryCount = {
    collections: payload.collections.length,
    topics: tags.length,
    tags: tags.length,
    saved: payload.savedSearches.length,
  }[tab];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 bg-white px-5 pt-3">
        {ORGANIZATION_TABS.map((candidate) => (
          <Link
            key={candidate}
            href={organizationPath(candidate)}
            aria-current={candidate === tab ? "page" : undefined}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium ${
              candidate === tab ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"
            }`}
          >
            {TAB_LABELS[candidate]}
          </Link>
        ))}
      </div>
      <section
        aria-label={TAB_LABELS[tab]}
        className="max-h-72 shrink-0 overflow-y-auto bg-white px-5 py-4"
      >
        {entryCount === 0 && <p className="py-4 text-sm text-muted">{EMPTY_TEXT[tab]}</p>}
        {tab === "collections" && <CollectionTree payload={payload} entry={entry} />}
        {(tab === "topics" || tab === "tags") && <TagList tags={tags} tab={tab} entry={entry} />}
        {tab === "saved" && <SavedSearchList payload={payload} entry={entry} />}
      </section>
      {entry !== null && <EntryHeader {...props} entry={entry} />}
      {entry === null ? (
        <p className="border-t border-line px-5 py-10 text-center text-sm text-muted">
          Choose one of the {TAB_LABELS[tab].toLowerCase()} above to see its PDFs.
        </p>
      ) : (
        table
      )}
    </div>
  );
}
