// The headless table engine for the library view: column visibility, order, sizing and
// sorting are TanStack state; the layout is persisted in localStorage.
import {
  type Column,
  type ColumnOrderState,
  type ColumnSizingState,
  getCoreRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  type Table,
  type Updater,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { useEffect, useState } from "react";
import type { BucketItem } from "../server/libraryContract";
import {
  BUCKET_COLUMNS,
  type ColumnLayout,
  defaultColumnLayout,
  LOCKED_COLUMN_ID,
  writeColumnLayout,
} from "./columnModel";

function applyUpdater<T>(updater: Updater<T>, previous: T): T {
  return updater instanceof Function ? updater(previous) : updater;
}

export function useLibraryTable(
  items: BucketItem[],
  initialLayout: ColumnLayout,
): Table<BucketItem> {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    initialLayout.columnVisibility,
  );
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(initialLayout.columnOrder);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(initialLayout.columnSizing);
  const [sorting, setSorting] = useState<SortingState>([{ id: "dateAdded", desc: true }]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  useEffect(() => {
    writeColumnLayout({ columnVisibility, columnOrder, columnSizing });
  }, [columnVisibility, columnOrder, columnSizing]);

  return useReactTable<BucketItem>({
    data: items,
    columns: BUCKET_COLUMNS,
    state: { columnVisibility, columnOrder, columnSizing, sorting, rowSelection },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: (updater) =>
      setColumnVisibility((previous) => ({
        ...applyUpdater(updater, previous),
        [LOCKED_COLUMN_ID]: true,
      })),
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    getRowId: (item) => item.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
}

// Every leaf column, hidden ones included, in the user's column order.
export function orderedLeafColumns(table: Table<BucketItem>): Column<BucketItem, unknown>[] {
  const byId = new Map(table.getAllLeafColumns().map((column) => [column.id, column]));
  return table
    .getState()
    .columnOrder.map((id) => byId.get(id))
    .filter((column) => column !== undefined);
}

export function resetColumnLayout(table: Table<BucketItem>): void {
  const layout = defaultColumnLayout();
  table.setColumnVisibility(layout.columnVisibility);
  table.setColumnOrder(layout.columnOrder);
  table.setColumnSizing(layout.columnSizing);
}

// Header drag: the dragged column takes the dropped column's slot.
export function reorderColumn(table: Table<BucketItem>, draggedId: string, targetId: string): void {
  if (draggedId === targetId) {
    return;
  }
  table.setColumnOrder((previous) => {
    const order = previous.filter((id) => id !== draggedId);
    order.splice(order.indexOf(targetId), 0, draggedId);
    return order;
  });
}
