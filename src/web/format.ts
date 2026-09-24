// Display forms shared by the table, the inspector and the palette.
import { type Reading, type SourceCheck, TOPIC_PREFIX } from "../server/libraryContract";

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
