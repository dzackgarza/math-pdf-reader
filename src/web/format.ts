// Display forms shared by the table, the inspector and the palette.
import {
  type Activity,
  type AVAILABILITIES,
  type READING_STATES,
  type Reading,
  type Rule,
  type RuleField,
  type SourceCheck,
  TOPIC_PREFIX,
} from "../contract/library";

// Authors as a table cell shows them, after Zotero's Creator column: one surname, two joined
// with "&", three or more as the first surname and "et al.". A surname is taken as the name's
// last word.
export function authorList(authors: string[]): string {
  const surname = (name: string) => name.split(" ").at(-1) ?? name;
  if (authors.length >= 3) {
    return `${surname(authors[0] ?? "")} et al.`;
  }
  return authors.map(surname).join(" & ");
}

// The last viewed page out of the page count, or "Unread" for an item never opened.
export function readingText(reading: Reading): string {
  return reading.status === "viewed" ? `${reading.page} / ${reading.pages}` : "Unread";
}

// When a URL was last checked and what the check found.
export function sourceCheckText(check: SourceCheck): string {
  return check.status === "unchecked"
    ? "Not verified"
    : `Last verified ${dateTime(check.checkedAt)}: ${check.detail}`;
}

// The item's first page as a PNG, WIDTH pixels wide.
export function thumbnailPath(key: string, width: number): string {
  return `/api/items/${encodeURIComponent(key)}/thumbnail?width=${width}`;
}

export const RULE_FIELD_LABELS: Record<RuleField, string> = {
  text: "Text",
  title: "Title",
  author: "Author",
  tag: "Tag",
  topic: "Topic",
  collection: "Collection",
  source: "Source",
  added: "Added",
  reading: "Read",
  status: "Status",
};

const RULE_VALUE_LABELS: Record<
  (typeof READING_STATES)[number] | (typeof AVAILABILITIES)[number],
  string
> = {
  unread: "Unread",
  reading: "being read",
  finished: "finished",
  cached: "Cached",
  offline: "Offline",
};

// A rule as a smart collection's summary says it; COLLECTION_NAMES names collection ids, and an
// id it lacks is a collection deleted since the rule was saved.
export function ruleText(rule: Rule, collectionNames: Map<string, string>): string {
  switch (rule.field) {
    case "text":
      return `Text matches “${rule.search.query}”`;
    case "added":
      return `Added in the last ${rule.value} days`;
    case "collection": {
      const name = collectionNames.get(rule.value);
      return `Collection ${rule.operator} ${name === undefined ? "a deleted collection" : name}`;
    }
    case "reading":
    case "status":
      return `${RULE_FIELD_LABELS[rule.field]} ${rule.operator} ${RULE_VALUE_LABELS[rule.value]}`;
    default:
      return `${RULE_FIELD_LABELS[rule.field]} ${rule.operator} “${rule.value}”`;
  }
}

export function pdfCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "PDF" : "PDFs"}`;
}

// A collection's activity entry as its Recent activity list says it.
export function activityText(activity: Activity): string {
  switch (activity.kind) {
    case "created":
      return "Created the collection";
    case "filed":
      return `Added ${pdfCount(activity.count)}`;
    case "tagged":
      return `Tagged ${pdfCount(activity.count)} with ${activity.tags.map(tagLabel).join(", ")}`;
    case "keptOffline":
      return activity.on ? "Kept offline" : "No longer kept offline";
  }
}

export function sourceDomain(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function isTopic(tag: string): boolean {
  return tag.startsWith(TOPIC_PREFIX);
}

export function topicName(tag: string): string {
  return tag.slice(TOPIC_PREFIX.length);
}

export function topicTag(name: string): string {
  return `${TOPIC_PREFIX}${name}`;
}

// A tag as the library shows it: a topic without its namespace, any other tag as written.
export function tagLabel(tag: string): string {
  return isTopic(tag) ? topicName(tag) : tag;
}
