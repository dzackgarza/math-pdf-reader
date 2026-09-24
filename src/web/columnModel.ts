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
import { authorList, sourceDomain, tagLabel } from "./format";
import { availability } from "./librarySelectors";

export const COLUMN_KEYS = [
  "title",
  "authors",
  "reading",
  "status",
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
  { key: "title", label: "Title", visible: true, width: 380 },
  { key: "authors", label: "Authors", visible: true, width: 200 },
  { key: "reading", label: "Read", visible: true, width: 100 },
  { key: "status", label: "Status", visible: true, width: 110 },
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

const COLUMN_STORAGE_KEY = "pdf-bucket:columns:v2";

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

// The text each column shows and sorts by.
const CELL_TEXT: Record<ColumnKey, (item: BucketItem) => string> = {
  title: (item) => item.title,
  authors: (item) => authorList(item.authors),
  // Sorts by the fraction read; an unread item before any opened one.
  reading: (item) =>
    String(item.reading.status === "viewed" ? item.reading.page / item.reading.pages : -1),
  status: (item) => availability(item),
  source: (item) => sourceDomain(item.url),
  dateAdded: (item) => item.dateAdded,
  tags: (item) => item.tags.map(tagLabel).join(", "),
  collections: (item) => String(item.collections.length),
  sizeBytes: (item) => String(item.file.sizeBytes),
  notes: (item) => String(item.notes.length),
  dateModified: (item) => item.dateModified,
  key: (item) => item.id,
  pdfUrl: (item) => item.provenance.pdf_url,
};

const NUMERIC_COLUMNS = new Set<string>(["sizeBytes", "notes", "collections", "reading"]);

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
  accessorFn: CELL_TEXT[column.key],
  header: column.label,
  enableHiding: column.key !== LOCKED_COLUMN_ID,
  sortingFn: compareRows,
  size: column.width,
  minSize: MIN_COLUMN_WIDTH,
  meta: { label: column.label },
}));

export function columnKey(id: string): ColumnKey {
  return ColumnKeySchema.parse(id);
}
