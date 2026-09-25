import * as ContextMenu from "@radix-ui/react-context-menu";
import { type Cell, flexRender, type Table } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Eye, FileText, Inbox, RotateCcw } from "lucide-react";
import prettyBytes from "pretty-bytes";
import { type CSSProperties, type ReactNode, useState } from "react";
import type { BucketItem } from "../../contract/library";
import { type ColumnKey, columnKey } from "../columnModel";
import { authorList, readingText, shortDate, sourceCheckText, sourceDomain } from "../format";
import { availability } from "../librarySelectors";
import { orderedLeafColumns, reorderColumn, resetColumnLayout } from "../useLibraryTable";
import { CollectionChip, TagChip } from "./Chips";

type LibraryTableProps = {
  table: Table<BucketItem>;
  collectionNames: Map<string, string>;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onOpenItem: (id: string) => void;
  // The context menu of the row right-clicked, as ContextMenu.Content.
  rowMenu: (id: string) => ReactNode;
  empty: ReactNode;
};

const VISIBLE_CHIPS = 2;

function widthStyle(size: number): CSSProperties {
  return { width: size, minWidth: size, maxWidth: size };
}

function Overflow({ hidden }: { hidden: number }) {
  if (hidden <= 0) {
    return null;
  }
  return (
    <span className="rounded-full bg-surface px-1.5 py-0.5 text-xs text-muted">+{hidden}</span>
  );
}

function Chips({ children, hidden }: { children: ReactNode; hidden: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {children}
      <Overflow hidden={hidden} />
    </span>
  );
}

// Cached, or Offline when the PDF URL no longer serves the captured bytes and no mirror does;
// the last check shows on hover.
function StatusBadge({ item }: { item: BucketItem }) {
  const offline = availability(item) === "offline";
  return (
    <span
      title={sourceCheckText(item.sourceCheck)}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        offline ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${offline ? "bg-red-600" : "bg-green-600"}`}
      />
      <span data-status>{offline ? "Offline" : "Cached"}</span>
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted tabular-nums">{children}</span>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-muted">{children}</span>;
}

// How each column draws an item.
const CELL_RENDERERS: Record<
  ColumnKey,
  (item: BucketItem, names: Map<string, string>) => ReactNode
> = {
  title: (item) => (
    <span className="flex min-w-0 items-center gap-2.5">
      <FileText aria-hidden className="h-4 w-4 shrink-0 text-danger" />
      <span className="truncate font-medium text-ink" title={item.title}>
        {item.title}
      </span>
    </span>
  ),
  authors: (item) => (
    <span className="truncate text-muted" title={item.authors.join("; ")}>
      {authorList(item.authors)}
    </span>
  ),
  reading: (item) => (
    <span data-reading className="text-muted tabular-nums">
      {readingText(item.reading)}
    </span>
  ),
  status: (item) => <StatusBadge item={item} />,
  source: (item) => <Muted>{sourceDomain(item.url)}</Muted>,
  dateAdded: (item) => <Muted>{shortDate(item.dateAdded)}</Muted>,
  dateModified: (item) => <Muted>{shortDate(item.dateModified)}</Muted>,
  tags: (item) => (
    <Chips hidden={item.tags.length - VISIBLE_CHIPS}>
      {item.tags.slice(0, VISIBLE_CHIPS).map((tag) => (
        <TagChip key={tag} tag={tag} />
      ))}
    </Chips>
  ),
  collections: (item, names) => (
    <Chips hidden={item.collections.length - VISIBLE_CHIPS}>
      {item.collections.slice(0, VISIBLE_CHIPS).map((id) => (
        <CollectionChip key={id} id={id} names={names} />
      ))}
    </Chips>
  ),
  sizeBytes: (item) => <Muted>{prettyBytes(item.file.sizeBytes)}</Muted>,
  notes: (item) => <Muted>{item.notes.length}</Muted>,
  key: (item) => <Mono>{item.id}</Mono>,
  pdfUrl: (item) => <Mono>{item.provenance.pdf_url}</Mono>,
};

function renderCell(cell: Cell<BucketItem, unknown>, names: Map<string, string>): ReactNode {
  return CELL_RENDERERS[columnKey(cell.column.id)](cell.row.original, names);
}

export default function LibraryTable({
  table,
  collectionNames,
  selectedItemId,
  onSelectItem,
  onOpenItem,
  rowMenu,
  empty,
}: LibraryTableProps) {
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const rows = table.getRowModel().rows;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ContextMenu.Root>
        <table
          className="w-full border-collapse text-left text-sm"
          style={{ minWidth: table.getTotalSize() }}
        >
          <ContextMenu.Trigger asChild>
            <thead className="sticky top-0 z-10 bg-panel shadow-[inset_0_-1px_0_var(--color-line)]">
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={table.getIsAllRowsSelected()}
                      ref={(input) => {
                        if (input !== null) {
                          input.indeterminate = table.getIsSomeRowsSelected();
                        }
                      }}
                      onChange={table.getToggleAllRowsSelectedHandler()}
                      className="accent-accent"
                    />
                  </th>
                  {group.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        draggable
                        onDragStart={() => setDraggedColumn(header.column.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (draggedColumn !== null) {
                            reorderColumn(table, draggedColumn, header.column.id);
                          }
                          setDraggedColumn(null);
                        }}
                        onClick={header.column.getToggleSortingHandler()}
                        style={widthStyle(header.getSize())}
                        className="relative cursor-pointer select-none px-4 py-2.5 text-xs font-semibold text-muted hover:text-ink"
                      >
                        <span className="flex items-center gap-1">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" && <ChevronUp className="h-3.5 w-3.5" />}
                          {sorted === "desc" && <ChevronDown className="h-3.5 w-3.5" />}
                        </span>
                        <span
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${header.column.id}`}
                          onMouseDown={header.getResizeHandler()}
                          onClick={(event) => event.stopPropagation()}
                          className="absolute top-2 right-0 bottom-2 w-1 cursor-col-resize rounded bg-line opacity-0 hover:opacity-100"
                        />
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
          </ContextMenu.Trigger>
          <ContextMenu.Root onOpenChange={(open) => !open && setMenuRow(null)}>
            <ContextMenu.Trigger asChild>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={table.getVisibleLeafColumns().length + 1}
                      className="px-6 py-20 text-center"
                    >
                      <Inbox aria-hidden className="mx-auto mb-3 h-9 w-9 text-faint" />
                      {empty}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const selected = row.id === selectedItemId;
                    return (
                      <tr
                        key={row.id}
                        data-item-id={row.id}
                        aria-selected={selected}
                        onContextMenu={() => {
                          onSelectItem(row.id);
                          setMenuRow(row.id);
                        }}
                        onClick={() => onSelectItem(row.id)}
                        onDoubleClick={() => onOpenItem(row.id)}
                        className={`cursor-default border-b border-line ${
                          selected ? "bg-accent-soft" : "bg-panel hover:bg-surface"
                        }`}
                      >
                        <td className="w-10 px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.original.title}`}
                            checked={row.getIsSelected()}
                            onChange={row.getToggleSelectedHandler()}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            className="accent-accent"
                          />
                        </td>
                        {row.getVisibleCells().map((cell) => (
                          <td
                            key={cell.id}
                            data-column={cell.column.id}
                            style={widthStyle(cell.column.getSize())}
                            className="truncate px-4 py-2"
                          >
                            {renderCell(cell, collectionNames)}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>{menuRow !== null && rowMenu(menuRow)}</ContextMenu.Portal>
          </ContextMenu.Root>
        </table>

        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 w-60 rounded-lg border border-line bg-panel p-2 text-sm shadow-lg">
            <div className="flex items-center justify-between px-2 pb-2 text-xs font-semibold text-muted">
              <span className="flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" /> Columns
              </span>
              <button
                type="button"
                onClick={() => resetColumnLayout(table)}
                className="flex items-center gap-1 text-accent hover:underline"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            </div>
            {orderedLeafColumns(table).map((column) => (
              <label
                key={column.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-surface"
              >
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  disabled={!column.getCanHide()}
                  onChange={column.getToggleVisibilityHandler()}
                  className="accent-accent"
                />
                {column.columnDef.meta?.label}
              </label>
            ))}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}
