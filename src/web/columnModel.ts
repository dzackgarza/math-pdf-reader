// The library table's columns and their persisted layout (visibility, order, widths).
import type {
  ColumnDef,
  ColumnOrderState,
  ColumnSizingState,
  Row,
  RowData,
  VisibilityState,
} from "@tanstack/react-table";
import { z } from "zod";
import type { BucketItem } from "../server/libraryContract";
import { isTopic, sourceDomain, topicName } from "./format";

export const COLUMN_KEYS = [
  "title",
  "source",
  "dateAdded",
  "tags",
  "collections",
  "sizeBytes",
  "notes",
  "dateModified",
  "key",
  "pdfUrl",
] as const;

export type ColumnKey = (typeof COLUMN_KEYS)[number];

type ColumnDefinition = { key: ColumnKey; label: string; visible: boolean; width: number };

const DEFAULT_COLUMNS: ColumnDefinition[] = [
  { key: "title", label: "Title", visible: true, width: 420 },
  { key: "source", label: "Source", visible: true, width: 170 },
  { key: "dateAdded", label: "Added", visible: true, width: 130 },
  { key: "tags", label: "Tags", visible: true, width: 260 },
  { key: "collections", label: "Collections", visible: false, width: 200 },
  { key: "sizeBytes", label: "Size", visible: false, width: 90 },
  { key: "notes", label: "Notes", visible: false, width: 80 },
  { key: "dateModified", label: "Modified", visible: false, width: 130 },
  { key: "key", label: "Key", visible: false, width: 160 },
  { key: "pdfUrl", label: "PDF URL", visible: false, width: 260 },
];

// The title column carries the row's identity and can never be hidden.
export const LOCKED_COLUMN_ID: ColumnKey = "title";

const MIN_COLUMN_WIDTH = 60;

const COLUMN_STORAGE_KEY = "pdf-bucket:columns:v1";

export type ColumnLayout = {
  columnVisibility: VisibilityState;
  columnOrder: ColumnOrderState;
  columnSizing: ColumnSizingState;
};

const ColumnKeySchema = z.enum(COLUMN_KEYS);

const StoredColumnLayoutSchema = z.strictObject({
  columnVisibility: z.record(ColumnKeySchema, z.boolean()),
  columnOrder: z.array(ColumnKeySchema).length(COLUMN_KEYS.length),
  columnSizing: z.record(ColumnKeySchema, z.number().positive()),
});

export function defaultColumnLayout(): ColumnLayout {
  return {
    columnVisibility: Object.fromEntries(
      DEFAULT_COLUMNS.map((column) => [column.key, column.visible]),
    ),
    columnOrder: DEFAULT_COLUMNS.map((column) => column.key),
    columnSizing: Object.fromEntries(DEFAULT_COLUMNS.map((column) => [column.key, column.width])),
  };
}

// The stored layout, the default when nothing is stored, or the reason the stored value is
// unusable: a layout from an older column set is reported, never silently replaced.
export type ColumnLayoutRead =
  | { status: "ready"; layout: ColumnLayout }
  | { status: "invalid"; reason: string };

export function readColumnLayout(): ColumnLayoutRead {
  const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
  if (raw === null) {
    return { status: "ready", layout: defaultColumnLayout() };
  }
  const stored = StoredColumnLayoutSchema.safeParse(JSON.parse(raw));
  if (!stored.success) {
    return { status: "invalid", reason: stored.error.message };
  }
  return {
    status: "ready",
    layout: {
      ...stored.data,
      columnVisibility: { ...stored.data.columnVisibility, [LOCKED_COLUMN_ID]: true },
    },
  };
}

export function writeColumnLayout(layout: ColumnLayout): void {
  localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(layout));
}

// The text a column shows and sorts by.
export function cellText(item: BucketItem, key: ColumnKey): string {
  switch (key) {
    case "title":
      return item.title;
    case "source":
      return sourceDomain(item.url);
    case "dateAdded":
      return item.dateAdded;
    case "tags":
      return item.tags.map((tag) => (isTopic(tag) ? topicName(tag) : tag)).join(", ");
    case "collections":
      return String(item.collections.length);
    case "sizeBytes":
      return String(item.file.sizeBytes);
    case "notes":
      return String(item.notes.length);
    case "dateModified":
      return item.dateModified;
    case "key":
      return item.id;
    case "pdfUrl":
      return item.provenance.pdf_url;
  }
}

const NUMERIC_COLUMNS = new Set<string>(["sizeBytes", "notes", "collections"]);

function compareRows(left: Row<BucketItem>, right: Row<BucketItem>, columnId: string): number {
  const a = left.getValue<string>(columnId);
  const b = right.getValue<string>(columnId);
  if (NUMERIC_COLUMNS.has(columnId)) {
    return Number(a) - Number(b);
  }
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    label: string;
    readonly bucketColumnTypes?: readonly [TData, TValue];
  }
}

export const BUCKET_COLUMNS: ColumnDef<BucketItem>[] = DEFAULT_COLUMNS.map((column) => ({
  id: column.key,
  accessorFn: (item: BucketItem) => cellText(item, column.key),
  header: column.label,
  enableHiding: column.key !== LOCKED_COLUMN_ID,
  sortingFn: compareRows,
  size: column.width,
  minSize: MIN_COLUMN_WIDTH,
  meta: { label: column.label },
}));
