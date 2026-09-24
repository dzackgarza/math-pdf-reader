// The smart collection editor: a name, whether an item must meet all rules or any, and the
// rules, each a field, an operator and a value; the count of PDFs matching updates as they change.
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import {
  type LibraryPayload,
  READING_STATES,
  RULE_FIELDS,
  type Rule,
  RuleSchema,
  type SavedSearch,
} from "../../contract/library";
import { isTopic, pdfCount, RULE_FIELD_LABELS, sourceDomain, topicName } from "../format";
import { itemsMatching, tagCounts } from "../librarySelectors";
import { newRule, OPERATORS } from "../smartRules";

export type SmartCollectionDraft = Omit<SavedSearch, "id">;

type SmartCollectionDialogProps = {
  payload: LibraryPayload;
  initial: SmartCollectionDraft;
  title: string;
  onSave: (draft: SmartCollectionDraft) => void;
  onClose: () => void;
};

const READING_LABELS = { unread: "Unread", reading: "Being read", finished: "Finished" } as const;
const INPUT =
  "min-w-0 rounded-md border border-line bg-panel px-2 py-1.5 text-sm outline-none focus:border-accent";

function Options({ values }: { values: [string, string][] }) {
  return values.map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

function RuleValue({
  payload,
  rule,
  label,
  onChange,
}: {
  payload: LibraryPayload;
  rule: Rule;
  label: string;
  onChange: (rule: Rule) => void;
}) {
  const tags = tagCounts(payload.items).map(([tag]) => tag);
  switch (rule.field) {
    case "text":
      return (
        <input
          aria-label={label}
          value={rule.search.query}
          onChange={(event) =>
            onChange({ ...rule, search: { ...rule.search, query: event.target.value } })
          }
          className={`${INPUT} flex-1`}
        />
      );
    case "title":
    case "author":
      return (
        <input
          aria-label={label}
          value={rule.value}
          onChange={(event) => onChange({ ...rule, value: event.target.value })}
          className={`${INPUT} flex-1`}
        />
      );
    case "added":
      return (
        <input
          aria-label={label}
          type="number"
          min={1}
          value={rule.value}
          onChange={(event) => {
            const days = event.target.valueAsNumber;
            if (Number.isInteger(days) && days >= 1) {
              onChange({ ...rule, value: days });
            }
          }}
          className={`${INPUT} w-20`}
        />
      );
    case "tag":
    case "topic":
    case "collection":
    case "source": {
      const choices: [string, string][] = {
        tag: tags.filter((tag) => !isTopic(tag)).map((tag): [string, string] => [tag, tag]),
        topic: tags
          .filter(isTopic)
          .map((tag): [string, string] => [topicName(tag), topicName(tag)]),
        collection: payload.collections.map((collection): [string, string] => [
          collection.id,
          collection.name,
        ]),
        source: [...new Set(payload.items.map((item) => sourceDomain(item.url)))]
          .sort()
          .map((domain): [string, string] => [domain, domain]),
      }[rule.field];
      return (
        <select
          aria-label={label}
          value={rule.value}
          onChange={(event) => onChange({ ...rule, value: event.target.value })}
          className={`${INPUT} flex-1`}
        >
          <Options values={choices} />
        </select>
      );
    }
    case "reading":
      return (
        <select
          aria-label={label}
          value={rule.value}
          onChange={(event) => {
            const value = READING_STATES.find((state) => state === event.target.value);
            if (value !== undefined) {
              onChange({ ...rule, value });
            }
          }}
          className={`${INPUT} flex-1`}
        >
          <Options values={READING_STATES.map((state) => [state, READING_LABELS[state]])} />
        </select>
      );
    case "status":
      return (
        <select
          aria-label={label}
          value={rule.value}
          onChange={(event) =>
            onChange({ ...rule, value: event.target.value === "cached" ? "cached" : "offline" })
          }
          className={`${INPUT} flex-1`}
        >
          <Options
            values={[
              ["cached", "Cached"],
              ["offline", "Offline"],
            ]}
          />
        </select>
      );
  }
}

function complete(rule: Rule): boolean {
  if (rule.field === "text") {
    return rule.search.query.trim() !== "";
  }
  return typeof rule.value === "number" || rule.value.trim() !== "";
}

export default function SmartCollectionDialog({
  payload,
  initial,
  title,
  onSave,
  onClose,
}: SmartCollectionDialogProps) {
  const [draft, setDraft] = useState<SmartCollectionDraft>(initial);
  const setRule = (index: number, rule: Rule) =>
    setDraft({ ...draft, rules: draft.rules.map((old, at) => (at === index ? rule : old)) });
  const ready = draft.name.trim() !== "" && draft.rules.length > 0 && draft.rules.every(complete);
  const matching = ready ? itemsMatching(payload, { ...draft, id: "draft" }).length : 0;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-2xl outline-none"
        >
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave({ ...draft, name: draft.name.trim() });
              onClose();
            }}
            className="mt-4 space-y-4 text-sm"
          >
            <label className="block">
              <span className="mb-1.5 block text-muted">Name</span>
              <input
                aria-label="Name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                className={`${INPUT} w-full`}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted">PDFs meeting</span>
              <select
                aria-label="Match"
                value={draft.match}
                onChange={(event) =>
                  setDraft({ ...draft, match: event.target.value === "any" ? "any" : "all" })
                }
                className={INPUT}
              >
                <option value="all">all of the rules</option>
                <option value="any">any of the rules</option>
              </select>
            </label>
            <ol className="space-y-2">
              {draft.rules.map((rule, index) => (
                <li key={`${index}-${rule.field}`} className="flex items-center gap-2">
                  <select
                    aria-label={`Rule ${index + 1} field`}
                    value={rule.field}
                    onChange={(event) => {
                      const field = RULE_FIELDS.find(
                        (candidate) => candidate === event.target.value,
                      );
                      if (field !== undefined) {
                        setRule(index, newRule(payload, field));
                      }
                    }}
                    className={INPUT}
                  >
                    <Options
                      values={RULE_FIELDS.map((field) => [field, RULE_FIELD_LABELS[field]])}
                    />
                  </select>
                  <select
                    aria-label={`Rule ${index + 1} operator`}
                    value={rule.operator}
                    onChange={(event) => {
                      const changed = RuleSchema.safeParse({
                        ...rule,
                        operator: event.target.value,
                      });
                      if (changed.success) {
                        setRule(index, changed.data);
                      }
                    }}
                    className={INPUT}
                  >
                    <Options
                      values={OPERATORS[rule.field].map((operator) => [operator, operator])}
                    />
                  </select>
                  <RuleValue
                    payload={payload}
                    rule={rule}
                    label={`Rule ${index + 1} value`}
                    onChange={(changed) => setRule(index, changed)}
                  />
                  <button
                    type="button"
                    aria-label={`Remove rule ${index + 1}`}
                    onClick={() =>
                      setDraft({ ...draft, rules: draft.rules.filter((_, at) => at !== index) })
                    }
                    className="rounded p-1 text-muted hover:bg-surface hover:text-ink"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ol>
            <button
              type="button"
              aria-label="Add rule"
              onClick={() =>
                setDraft({ ...draft, rules: [...draft.rules, newRule(payload, "collection")] })
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-medium hover:bg-surface"
            >
              <Plus className="h-4 w-4" /> Add Rule
            </button>
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-muted" role="status">
                {ready
                  ? `${pdfCount(matching)} ${matching === 1 ? "matches" : "match"}`
                  : "Complete every rule"}
              </span>
              <Dialog.Close className="rounded-lg border border-line px-3.5 py-2 font-medium hover:bg-surface">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!ready}
                className="rounded-lg bg-accent px-3.5 py-2 font-medium text-white disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
