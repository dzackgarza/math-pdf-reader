import { BookmarkPlus, FolderPlus, Search, SlidersHorizontal } from "lucide-react";
import type { AdvancedSearchSettings } from "../../server/libraryContract";
import { formatShortcut, KEYBOARD_SHORTCUTS } from "../keyboardShortcuts";
import { defaultSearchSettings } from "../search";

type TopBarProps = {
  search: AdvancedSearchSettings;
  onChangeSearch: (search: AdvancedSearchSettings) => void;
  onOpenFilters: () => void;
  onOpenPalette: () => void;
  onSaveSearch: () => void;
  onNewCollection: () => void;
};

const BUTTON_CLASSES =
  "inline-flex shrink-0 items-center gap-2 rounded-lg border border-line bg-white px-3.5 py-2 text-sm font-medium hover:bg-surface disabled:opacity-40";

// Whether the filters differ from the plain title/source/tag search.
function filtersChanged(search: AdvancedSearchSettings): boolean {
  const plain = defaultSearchSettings();
  return (
    search.matchCase !== plain.matchCase ||
    search.matchType !== plain.matchType ||
    JSON.stringify(search.searchFields) !== JSON.stringify(plain.searchFields)
  );
}

export default function TopBar({
  search,
  onChangeSearch,
  onOpenFilters,
  onOpenPalette,
  onSaveSearch,
  onNewCollection,
}: TopBarProps) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line bg-white px-5 py-3">
      <label className="relative flex max-w-xl min-w-48 flex-1 items-center">
        <Search aria-hidden className="absolute left-3 h-4 w-4 text-faint" />
        <input
          type="search"
          aria-label="Search your PDFs"
          value={search.query}
          onChange={(event) => onChangeSearch({ ...search, query: event.target.value })}
          placeholder="Search your PDFs (title, source, tags…)"
          className="w-full rounded-lg border border-line bg-white py-2 pr-20 pl-9 text-sm outline-none placeholder:text-faint focus:border-accent"
        />
        <button
          type="button"
          onClick={onOpenPalette}
          className="absolute right-2 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs text-muted hover:text-ink"
        >
          {formatShortcut(KEYBOARD_SHORTCUTS.openItemPalette)}
        </button>
      </label>
      <button type="button" onClick={onOpenFilters} className={BUTTON_CLASSES}>
        <SlidersHorizontal className="h-4 w-4" /> Filters
        {filtersChanged(search) && (
          <span className="h-2 w-2 rounded-full bg-accent" aria-label="Filters changed" />
        )}
      </button>
      <button
        type="button"
        onClick={onSaveSearch}
        disabled={search.query.trim().length === 0}
        className={BUTTON_CLASSES}
      >
        <BookmarkPlus className="h-4 w-4" /> Save Search
      </button>
      <button
        type="button"
        onClick={onNewCollection}
        className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        <FolderPlus className="h-4 w-4" /> New Collection
      </button>
    </div>
  );
}
