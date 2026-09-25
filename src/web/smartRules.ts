// The smart collection editor's choices: the operators each rule field takes, the values the
// library offers for a field, a new rule on a field, and whether a rule is ready to save.
import { z } from "zod";
import {
  CONTAINS_OPERATORS,
  IS_OPERATORS,
  type LibraryPayload,
  type Rule,
  type RuleField,
} from "../contract/library";
import { isTopic, sourceDomain, topicName } from "./format";
import { tagCounts } from "./librarySelectors";
import { defaultSearchSettings } from "./search";

export const OPERATORS = {
  text: ["matches"],
  title: CONTAINS_OPERATORS,
  author: CONTAINS_OPERATORS,
  tag: IS_OPERATORS,
  topic: IS_OPERATORS,
  collection: IS_OPERATORS,
  source: IS_OPERATORS,
  added: ["within days"],
  reading: IS_OPERATORS,
  status: IS_OPERATORS,
} as const satisfies Record<RuleField, readonly string[]>;

// The fields whose value is one the library already holds.
export type ChoiceField = "tag" | "topic" | "collection" | "source";

// The values the library offers for a choice field, each with its label.
export function choices(payload: LibraryPayload, field: ChoiceField): [string, string][] {
  const tags = tagCounts(payload.items).map(([tag]) => tag);
  switch (field) {
    case "tag":
      return tags.filter((tag) => !isTopic(tag)).map((tag) => [tag, tag]);
    case "topic":
      return tags.filter(isTopic).map((tag) => [topicName(tag), topicName(tag)]);
    case "collection":
      return payload.collections.map((collection) => [collection.id, collection.name]);
    case "source":
      return [...new Set(payload.items.map((item) => sourceDomain(item.url)))]
        .sort()
        .map((domain) => [domain, domain]);
  }
}

// A new rule on FIELD, with the first value the library offers for it; null for a choice field
// the library offers no value for.
export function newRule(payload: LibraryPayload, field: RuleField): Rule | null {
  switch (field) {
    case "text":
      return { field, operator: "matches", search: defaultSearchSettings() };
    case "title":
    case "author":
      return { field, operator: "contains", value: "" };
    case "tag":
    case "topic":
    case "collection":
    case "source": {
      const first = choices(payload, field)[0];
      return first === undefined ? null : { field, operator: "is", value: first[0] };
    }
    case "added":
      return { field, operator: "within days", value: 7 };
    case "reading":
      return { field, operator: "is", value: "unread" };
    case "status":
      return { field, operator: "is", value: "offline" };
  }
}

// The rule a new smart collection and Add Rule start from: the first collection, or the text
// search when the library has no collection.
export function firstRule(payload: LibraryPayload): Rule {
  const collection = newRule(payload, "collection");
  if (collection !== null) {
    return collection;
  }
  return { field: "text", operator: "matches", search: defaultSearchSettings() };
}

// RULE with OPERATOR, one of the operators its field takes.
export function withOperator(rule: Rule, operator: string): Rule {
  switch (rule.field) {
    case "text":
      return { ...rule, operator: z.enum(OPERATORS.text).parse(operator) };
    case "title":
    case "author":
      return { ...rule, operator: z.enum(CONTAINS_OPERATORS).parse(operator) };
    case "added":
      return { ...rule, operator: z.enum(OPERATORS.added).parse(operator) };
    case "tag":
    case "topic":
    case "collection":
    case "source":
    case "reading":
    case "status":
      return { ...rule, operator: z.enum(IS_OPERATORS).parse(operator) };
  }
}

// Whether RULE names something to match: typed text, or a collection the library holds.
export function complete(payload: LibraryPayload, rule: Rule): boolean {
  switch (rule.field) {
    case "text":
      return rule.search.query.trim() !== "";
    case "title":
    case "author":
    case "tag":
    case "topic":
    case "source":
      return rule.value.trim() !== "";
    case "collection":
      return payload.collections.some((collection) => collection.id === rule.value);
    case "added":
    case "reading":
    case "status":
      return true;
  }
}

// RULE as the server takes it: typed values without surrounding whitespace.
export function trimmedRule(rule: Rule): Rule {
  switch (rule.field) {
    case "title":
    case "author":
      return { ...rule, value: rule.value.trim() };
    default:
      return rule;
  }
}
