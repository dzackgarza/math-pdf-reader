import { BookmarkPlus, FolderInput, Link2, Search, SlidersHorizontal } from "lucide-react";
import { forwardRef } from "react";
import type { AdvancedSearchSettings } from "../../contract/library";
import { defaultSearchSettings } from "../search";

type TopBarProps = {
  search: AdvancedSearchSettings;
  onChangeSearch: (search: AdvancedSearchSettings) => void;
  onOpenFilters: () => void;
  onSaveSearch: () => void;
  onImportUrl: () => void;
  onAddFolder: () => void;
};

const TEXT_BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm font-medium text-ink hover:bg-surface";

const ICON_BUTTON =
  "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink";

// Whether the filters differ from the plain title/source/tag search.
function filtersChanged(search: AdvancedSearchSettings): boolean {
  const plain = defaultSearchSettings();
  return (
    search.matchCase !== plain.matchCase ||
    search.matchType !== plain.matchType ||
    JSON.stringify(search.searchFields) !== JSON.stringify(plain.searchFields)
  );
}

// The search field the window focuses on Ctrl+F; Escape clears it.
const TopBar = forwardRef<HTMLInputElement, TopBarProps>(function TopBar(
  { search, onChangeSearch, onOpenFilters, onSaveSearch, onImportUrl, onAddFolder },
  ref,
) {
  const searching = search.query.trim().length > 0;
  return (
    <div className="flex items-center gap-1 border-b border-line bg-panel px-3 py-2">
      <label className="relative flex max-w-md min-w-40 flex-1 items-center">
        <Search aria-hidden className="absolute left-2.5 h-4 w-4 text-faint" />
        <input
          ref={ref}
          type="search"
          aria-label="Search"
          value={search.query}
          onChange={(event) => onChangeSearch({ ...search, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onChangeSearch({ ...search, query: "" });
              event.currentTarget.blur();
            }
          }}
          placeholder="Search"
          className="w-full rounded-md border border-line bg-panel py-1.5 pr-2 pl-8 text-sm outline-none placeholder:text-faint focus:border-accent"
        />
      </label>
      <button
        type="button"
        aria-label="Filters"
        title="Filters"
        onClick={onOpenFilters}
        className={ICON_BUTTON}
      >
        <SlidersHorizontal className="h-4 w-4" />
        {filtersChanged(search) && (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent" />
        )}
      </button>
      {searching && (
        <button
          type="button"
          aria-label="Save search"
          title="Save search"
          onClick={onSaveSearch}
          className={ICON_BUTTON}
        >
          <BookmarkPlus className="h-4 w-4" />
        </button>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" aria-label="Import URL" onClick={onImportUrl} className={TEXT_BUTTON}>
          <Link2 className="h-4 w-4" /> Import URL
        </button>
        <button type="button" aria-label="Add Folder" onClick={onAddFolder} className={TEXT_BUTTON}>
          <FolderInput className="h-4 w-4" /> Add Folder
        </button>
      </div>
    </div>
  );
});

export default TopBar;
