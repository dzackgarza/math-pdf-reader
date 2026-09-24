// The smart collection editor's choices: the operators each rule field takes, and a new rule
// on a field with the first value the library offers for it.
import type { LibraryPayload, Rule, RuleField } from "../server/libraryContract";
import { isTopic, sourceDomain, topicName } from "./format";
import { tagCounts } from "./librarySelectors";
import { defaultSearchSettings } from "./search";

export const OPERATORS: Record<RuleField, string[]> = {
  text: ["matches"],
  title: ["contains", "does not contain"],
  author: ["contains", "does not contain"],
  tag: ["is", "is not"],
  topic: ["is", "is not"],
  collection: ["is", "is not"],
  source: ["is", "is not"],
  added: ["within days"],
  reading: ["is", "is not"],
  status: ["is", "is not"],
};

export // A new rule on FIELD, with the first value the library offers for it.
function newRule(payload: LibraryPayload, field: RuleField): Rule {
  const tags = tagCounts(payload.items).map(([tag]) => tag);
  switch (field) {
    case "text":
      return { field, operator: "matches", search: defaultSearchSettings() };
    case "title":
    case "author":
      return { field, operator: "contains", value: "" };
    case "tag":
      return { field, operator: "is", value: tags.find((tag) => !isTopic(tag)) ?? "" };
    case "topic":
      return { field, operator: "is", value: topicName(tags.find(isTopic) ?? "") };
    case "collection":
      return { field, operator: "is", value: payload.collections[0]?.id ?? "" };
    case "source":
      return { field, operator: "is", value: sourceDomain(payload.items[0]?.url ?? "") };
    case "added":
      return { field, operator: "within days", value: 7 };
    case "reading":
      return { field, operator: "is", value: "unread" };
    case "status":
      return { field, operator: "is", value: "offline" };
  }
}
