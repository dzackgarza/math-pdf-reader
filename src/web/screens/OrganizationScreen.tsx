import {
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Search,
  Shapes,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  type Collection,
  type CollectionUpdate,
  type LibraryPayload,
  type SavedSearch,
} from "../../server/libraryContract";
import CollectionCards from "../components/CollectionCards";
import Switch from "../components/Switch";
import { activityText, dateTime, isTopic, pdfCount, ruleText, tagLabel } from "../format";
import { itemsInView, tagCounts, viewName } from "../librarySelectors";
import { entryView, ORGANIZATION_TABS, type OrganizationTab, organizationPath } from "../routes";

export type OrganizationActions = {
  newCollection: () => void;
  newSubcollection: (parent: Collection) => void;
  renameCollection: (collection: Collection) => void;
  deleteCollection: (collection: Collection) => void;
  updateCollection: (collection: Collection, update: CollectionUpdate) => void;
  editDescription: (collection: Collection) => void;
  deleteSavedSearch: (search: SavedSearch) => void;
  // Act on the rows chosen with their checkboxes.
  newTopic: () => void;
  bulkTag: () => void;
  newSmartCollection: () => void;
  editSmartCollection: (search: SavedSearch) => void;
};

type OrganizationScreenProps = {
  payload: LibraryPayload;
  tab: OrganizationTab;
  entry: string | null;
  actions: OrganizationActions;
  // How many rows are chosen with their checkboxes.
  chosen: number;
  table: ReactNode;
};

const TAB_LABELS: Record<OrganizationTab, string> = {
  collections: "Collections",
  topics: "Topics",
  tags: "Tags",
  saved: "Saved Searches",
};

const EMPTY_TEXT: Record<OrganizationTab, string> = {
  collections: "No collections",
  topics: "No topics",
  tags: "No tags",
  saved: "No saved searches",
};

function entryClasses(selected: boolean): string {
  return `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${
    selected ? "bg-accent-soft font-semibold text-accent" : "hover:bg-surface"
  }`;
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
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-1">
      {tags.map(([tag]) => (
        <li key={tag}>
          <Link href={organizationPath(tab, tag)} className={entryClasses(tag === entry)}>
            <Icon
              aria-hidden
              className={`h-4 w-4 shrink-0 ${tab === "topics" ? "text-topic" : "text-accent"}`}
            />
            <span className="truncate">{tagLabel(tag)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function searchSummary(payload: LibraryPayload, search: SavedSearch): string {
  const names = new Map(payload.collections.map((collection) => [collection.id, collection.name]));
  return search.rules
    .map((rule) => ruleText(rule, names))
    .join(search.match === "all" ? " and " : " or ");
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
                {searchSummary(payload, search)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const ACTION_CLASSES =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:bg-surface";

// A collection's page: its description, Keep offline, its subcollections and recent activity.
function CollectionDetails({
  payload,
  collection,
  actions,
}: {
  payload: LibraryPayload;
  collection: Collection;
  actions: OrganizationActions;
}) {
  const children = payload.collections.filter((candidate) => candidate.parentId === collection.id);
  const activity = payload.activity
    .filter((entry) => entry.collectionId === collection.id)
    .slice(-4)
    .reverse();
  return (
    <div className="grid gap-4 border-b border-line bg-panel px-5 pb-4 text-sm md:grid-cols-3">
      <div className="space-y-1.5">
        <p className={collection.description === "" ? "text-faint" : "text-ink"}>
          {collection.description === "" ? "No description" : collection.description}
        </p>
        <button
          type="button"
          aria-label="Edit description"
          onClick={() => actions.editDescription(collection)}
          className="text-xs font-medium text-accent hover:underline"
        >
          Edit description
        </button>
      </div>
      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block font-medium">Keep offline</span>
            <span className="block text-xs text-muted">
              Its PDFs stay in the bucket after Send to Zotero.
            </span>
          </span>
          <Switch
            label="Keep offline"
            on={collection.keepOffline}
            onChange={(keepOffline) => actions.updateCollection(collection, { keepOffline })}
          />
        </label>
        {children.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Subcollections ({children.length})</p>
            <ul className="space-y-0.5">
              {children.map((child) => (
                <li key={child.id} className="flex items-center justify-between">
                  <Link
                    href={organizationPath("collections", child.id)}
                    className="flex items-center gap-1.5 text-accent hover:underline"
                  >
                    <Folder aria-hidden className="h-3.5 w-3.5" /> {child.name}
                  </Link>
                  <span className="text-xs text-muted">
                    {itemsInView(payload, { kind: "collection", id: child.id }).length}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div>
        <p className="mb-1 font-medium">Recent activity</p>
        <ul className="space-y-1">
          {activity.map((entry) => (
            <li key={`${entry.at}-${entry.kind}`} className="flex justify-between gap-3 text-xs">
              <span>{activityText(entry)}</span>
              <time dateTime={entry.at} className="shrink-0 text-muted">
                {dateTime(entry.at)}
              </time>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

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
  const collection = payload.collections.find((candidate) => candidate.id === entry);
  const parent = payload.collections.find((candidate) => candidate.id === collection?.parentId);
  const saved = payload.savedSearches.find((candidate) => candidate.id === entry);

  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-line bg-panel px-5 py-3.5">
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
        {saved !== undefined && (
          <p className="text-sm text-muted">{searchSummary(payload, saved)}</p>
        )}
      </div>
      {collection !== undefined && <CollectionActions collection={collection} actions={actions} />}
      {collection !== undefined && (
        <p className="basis-full text-sm text-muted">
          {pdfCount(itemsInView(payload, view).length)}
        </p>
      )}
      {saved !== undefined && (
        <button
          type="button"
          aria-label="Edit rules"
          onClick={() => actions.editSmartCollection(saved)}
          className={ACTION_CLASSES}
        >
          <Pencil className="h-4 w-4" /> Edit
        </button>
      )}
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

const TOOLBAR_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-40";

// New collection, and the actions on the chosen rows: a new topic for them, a tag for them;
// and a new smart collection (a saved search built from rules).
function Toolbar({ actions, chosen }: { actions: OrganizationActions; chosen: number }) {
  const needsRows = chosen === 0 ? "Choose PDFs with their checkboxes first" : undefined;
  return (
    <div className="ml-auto flex flex-wrap gap-2">
      <button
        type="button"
        aria-label="New Collection"
        onClick={actions.newCollection}
        className={TOOLBAR_BUTTON}
      >
        <FolderPlus className="h-4 w-4" /> New Collection
      </button>
      <button
        type="button"
        aria-label="New Topic"
        title={needsRows}
        disabled={chosen === 0}
        onClick={actions.newTopic}
        className={TOOLBAR_BUTTON}
      >
        <Shapes className="h-4 w-4" /> New Topic
      </button>
      <button
        type="button"
        aria-label="Bulk Tag"
        title={needsRows}
        disabled={chosen === 0}
        onClick={actions.bulkTag}
        className={TOOLBAR_BUTTON}
      >
        <Tag className="h-4 w-4" /> Bulk Tag
      </button>
      <button
        type="button"
        aria-label="Smart Collection"
        onClick={actions.newSmartCollection}
        className={TOOLBAR_BUTTON}
      >
        <Sparkles className="h-4 w-4" /> Smart Collection
      </button>
    </div>
  );
}

export default function OrganizationScreen(props: OrganizationScreenProps) {
  const { payload, tab, entry, table, actions } = props;
  const collection =
    tab === "collections"
      ? payload.collections.find((candidate) => candidate.id === entry)
      : undefined;
  const tags = tagCounts(payload.items).filter(([tag]) => isTopic(tag) === (tab === "topics"));
  const entryCount = {
    collections: payload.collections.length,
    topics: tags.length,
    tags: tags.length,
    saved: payload.savedSearches.length,
  }[tab];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 bg-panel px-5 pt-3">
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
        <Toolbar actions={actions} chosen={props.chosen} />
      </div>
      <section
        aria-label={TAB_LABELS[tab]}
        className="max-h-72 shrink-0 overflow-y-auto bg-panel px-5 py-4"
      >
        {entryCount === 0 && <p className="py-4 text-sm text-muted">{EMPTY_TEXT[tab]}</p>}
        {tab === "collections" && (
          <CollectionCards
            payload={payload}
            entry={collection?.parentId ?? entry}
            onPin={(pinned, on) => actions.updateCollection(pinned, { pinned: on })}
          />
        )}
        {(tab === "topics" || tab === "tags") && <TagList tags={tags} tab={tab} entry={entry} />}
        {tab === "saved" && <SavedSearchList payload={payload} entry={entry} />}
      </section>
      {entry !== null && <EntryHeader {...props} entry={entry} />}
      {collection !== undefined && (
        <CollectionDetails payload={payload} collection={collection} actions={actions} />
      )}
      {entry !== null && table}
    </div>
  );
}
