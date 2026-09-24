// The bar above the library table: the quick filters (one at a time; a second click clears
// it) with their counts, and the Sort menu over the table's columns.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Table } from "@tanstack/react-table";
import { ArrowDownUp, Check } from "lucide-react";
import type { BucketItem, LibraryPayload } from "../../server/libraryContract";
import {
  type LibraryView,
  QUICK_FILTERS,
  quickFilterCount,
  quickFilterName,
} from "../librarySelectors";

type LibraryBarProps = {
  payload: LibraryPayload;
  view: LibraryView;
  navigate: (path: string) => void;
  table: Table<BucketItem>;
};

const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface";

function SortMenu({ table }: { table: Table<BucketItem> }) {
  const [sorted] = table.getState().sorting;
  const columns = table.getAllLeafColumns();
  const current = columns.find((column) => column.id === sorted?.id);
  const direction = sorted?.desc ? "descending" : "ascending";
  const sortBy = (id: string, desc: boolean) => table.setSorting([{ id, desc }]);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Sort"
        className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted hover:bg-surface hover:text-ink"
      >
        <ArrowDownUp aria-hidden className="h-4 w-4" />
        Sort: {current?.columnDef.meta?.label ?? "None"}
        {current !== undefined && (direction === "descending" ? " ↓" : " ↑")}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 w-52 rounded-lg border border-line bg-white p-1 text-sm shadow-lg"
        >
          <DropdownMenu.RadioGroup
            value={sorted?.id ?? ""}
            onValueChange={(id) => sortBy(id, sorted?.desc)}
          >
            {columns.map((column) => (
              <DropdownMenu.RadioItem key={column.id} value={column.id} className={MENU_ITEM}>
                <span className="w-4">
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-4 w-4 text-accent" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {column.columnDef.meta?.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.RadioGroup
            value={direction}
            onValueChange={(value) => sortBy(sorted?.id ?? "dateAdded", value === "descending")}
          >
            {(["ascending", "descending"] as const).map((value) => (
              <DropdownMenu.RadioItem key={value} value={value} className={MENU_ITEM}>
                <span className="w-4">
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-4 w-4 text-accent" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {value === "ascending" ? "Ascending" : "Descending"}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default function LibraryBar({ payload, view, navigate, table }: LibraryBarProps) {
  return (
    <div className="flex items-center gap-1.5 border-b border-line bg-white px-3 py-2">
      {QUICK_FILTERS.map((filter) => {
        const on = filter.view.kind === view.kind;
        const name = quickFilterName(filter);
        return (
          <button
            key={filter.path}
            type="button"
            aria-label={name}
            aria-pressed={on}
            onClick={() => navigate(on ? "/" : filter.path)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm ${
              on
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:bg-surface hover:text-ink"
            }`}
          >
            <span>{name}</span>
            <span className="text-xs tabular-nums">
              {quickFilterCount(payload, filter).toLocaleString()}
            </span>
          </button>
        );
      })}
      <SortMenu table={table} />
    </div>
  );
}
