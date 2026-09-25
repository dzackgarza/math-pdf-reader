// Filtering over the library items with fzf: the filter bar and saved searches match
// each whitespace token exactly and combine them with all/any; the command palette fuzzy-
// matches the whole query as one subsequence.
import { Fzf } from "fzf";
import {
  type AdvancedSearchSettings,
  AdvancedSearchSettingsSchema,
  type BucketItem,
  SEARCH_FIELDS,
  type SearchField,
} from "../contract/library";
import { sourceDomain } from "./format";

export type SearchDocument = { item: BucketItem } & Record<SearchField, string>;

export const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  title: "Title",
  source: "Source URL",
  pdfUrl: "PDF URL",
  tags: "Tags and topics",
  notes: "Notes",
  key: "Key",
};

const PALETTE_SEARCH_FIELDS: SearchField[] = ["title", "source", "tags"];

export function defaultSearchSettings(): AdvancedSearchSettings {
  const searched = new Set<SearchField>(PALETTE_SEARCH_FIELDS);
  return {
    query: "",
    matchCase: false,
    matchType: "all",
    searchFields: AdvancedSearchSettingsSchema.shape.searchFields.parse(
      Object.fromEntries(SEARCH_FIELDS.map((field) => [field, searched.has(field)])),
    ),
  };
}

export function buildSearchDocuments(items: BucketItem[]): SearchDocument[] {
  return items.map((item) => ({
    item,
    title: item.title,
    source: `${sourceDomain(item.url)} ${item.url}`,
    pdfUrl: item.provenance.pdf_url,
    tags: item.tags.join(" "),
    notes: item.notes.map((note) => note.note).join(" "),
    key: item.id,
  }));
}

function searchText(document: SearchDocument, fields: SearchField[]): string {
  return fields.map((field) => document[field]).join(" ");
}

export function filterItems(items: BucketItem[], settings: AdvancedSearchSettings): BucketItem[] {
  const query = settings.query.trim();
  if (query.length === 0) {
    return items;
  }
  const fields = SEARCH_FIELDS.filter((field) => settings.searchFields[field]);
  if (fields.length === 0) {
    return [];
  }
  // Each word must occur as written: the table and saved searches keep every match, so a
  // fuzzy subsequence match would fill them with items that only share scattered letters.
  const documents = buildSearchDocuments(items);
  const fzf = new Fzf(documents, {
    selector: (document) => searchText(document, fields),
    casing: settings.matchCase ? "case-sensitive" : "case-insensitive",
    normalize: true,
    fuzzy: false,
  });
  const matchesByToken = query
    .split(/\s+/)
    .map((token) => new Set(fzf.find(token).map((result) => result.item.item.id)));
  const matches =
    settings.matchType === "any"
      ? (id: string) => matchesByToken.some((ids) => ids.has(id))
      : (id: string) => matchesByToken.every((ids) => ids.has(id));
  return items.filter((item) => matches(item.id));
}

export function rankForPalette(documents: SearchDocument[], query: string): SearchDocument[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return documents;
  }
  const fzf = new Fzf(documents, {
    selector: (document) => searchText(document, PALETTE_SEARCH_FIELDS),
    casing: "case-insensitive",
    normalize: true,
  });
  return fzf.find(trimmed).map((result) => result.item);
}
