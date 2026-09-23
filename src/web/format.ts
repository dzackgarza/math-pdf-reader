// Display forms shared by the table, the inspector and the palette.
import { TOPIC_PREFIX } from "../server/libraryContract";

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
