// The library as cards: each PDF's first page, title, authors and how far it has been read.
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { Table } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import type { BucketItem } from "../../server/libraryContract";
import { authorList, readingText, thumbnailPath } from "../format";

type LibraryGridProps = {
  table: Table<BucketItem>;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onOpenItem: (id: string) => void;
  rowMenu: (id: string) => ReactNode;
  empty: ReactNode;
};

function Progress({ item }: { item: BucketItem }) {
  const { reading } = item;
  const fraction = reading.status === "viewed" ? reading.page / reading.pages : 0;
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-accent" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="tabular-nums">{readingText(reading)}</span>
    </div>
  );
}

export default function LibraryGrid({
  table,
  selectedItemId,
  onSelectItem,
  onOpenItem,
  rowMenu,
  empty,
}: LibraryGridProps) {
  const [menuItem, setMenuItem] = useState<string | null>(null);
  const rows = table.getRowModel().rows;
  if (rows.length === 0) {
    return <div className="min-h-0 flex-1 px-6 py-20 text-center">{empty}</div>;
  }
  return (
    <ContextMenu.Root onOpenChange={(open) => !open && setMenuItem(null)}>
      <ContextMenu.Trigger asChild>
        <ul className="grid min-h-0 flex-1 auto-rows-max grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4 overflow-auto p-4">
          {rows
            .map((row) => ({ row, item: row.original }))
            .map(({ row, item }) => (
              <li
                key={item.id}
                data-card-id={item.id}
                aria-selected={item.id === selectedItemId}
                onClick={() => onSelectItem(item.id)}
                onDoubleClick={() => onOpenItem(item.id)}
                onContextMenu={() => {
                  onSelectItem(item.id);
                  setMenuItem(item.id);
                }}
                className={`relative flex cursor-default flex-col gap-2 rounded-lg border p-2 ${
                  item.id === selectedItemId
                    ? "border-accent bg-accent-soft"
                    : "border-line bg-panel hover:bg-surface"
                }`}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${item.title}`}
                  checked={row.getIsSelected()}
                  onChange={row.getToggleSelectedHandler()}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="absolute top-3 left-3 accent-accent"
                />
                <img
                  src={thumbnailPath(item.id, 320)}
                  alt=""
                  loading="lazy"
                  className="aspect-[3/4] w-full rounded border border-line bg-panel object-cover object-top"
                />
                <p className="line-clamp-2 text-sm font-medium text-ink" title={item.title}>
                  {item.title}
                </p>
                <p className="truncate text-xs text-muted">{authorList(item.authors)}</p>
                <Progress item={item} />
              </li>
            ))}
        </ul>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>{menuItem !== null && rowMenu(menuItem)}</ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
