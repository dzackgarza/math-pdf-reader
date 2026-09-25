// The smart collection editor: a name, whether an item must meet all rules or any, and the
// rules, each a field, an operator and a value; the count of PDFs matching updates as they change.
// The dialog closes once the server has stored the collection; a refusal shows in the dialog,
// which keeps what was typed.
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import {
  AVAILABILITIES,
  type LibraryPayload,
  READING_STATES,
  RULE_FIELDS,
  type Rule,
  type SavedSearch,
  SavedSearchSchema,
} from "../../contract/library";
import { pdfCount, RULE_FIELD_LABELS } from "../format";
import { itemsMatching } from "../librarySelectors";
import { choices, complete, firstRule, newRule, OPERATORS, withOperator } from "../smartRules";

export type SmartCollectionDraft = Omit<SavedSearch, "id">;

type SmartCollectionDialogProps = {
  payload: LibraryPayload;
  initial: SmartCollectionDraft;
  title: string;
  onSave: (draft: SmartCollectionDraft) => Promise<void>;
  onClose: () => void;
};

const READING_LABELS = { unread: "Unread", reading: "Being read", finished: "Finished" } as const;
const AVAILABILITY_LABELS = { cached: "Cached", offline: "Offline" } as const;
const INPUT =
  "min-w-0 rounded-md border border-line bg-panel px-2 py-1.5 text-sm outline-none focus:border-accent";

function Options({ values }: { values: readonly (readonly [string, string])[] }) {
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
      const offered = choices(payload, rule.field);
      // A value no item carries any more stays shown; a collection deleted since is named so
      // until another is chosen.
      const absent = !offered.some(([value]) => value === rule.value);
      return (
        <select
          aria-label={label}
          value={rule.value}
          onChange={(event) => onChange({ ...rule, value: event.target.value })}
          className={`${INPUT} flex-1`}
        >
          {absent && (
            <option value={rule.value} disabled>
              {rule.field === "collection" ? "Deleted collection" : rule.value}
            </option>
          )}
          <Options values={offered} />
        </select>
      );
    }
    case "reading":
      return (
        <select
          aria-label={label}
          value={rule.value}
          onChange={(event) =>
            onChange({ ...rule, value: z.enum(READING_STATES).parse(event.target.value) })
          }
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
            onChange({ ...rule, value: z.enum(AVAILABILITIES).parse(event.target.value) })
          }
          className={`${INPUT} flex-1`}
        >
          <Options values={AVAILABILITIES.map((state) => [state, AVAILABILITY_LABELS[state]])} />
        </select>
      );
  }
}

// The field chooser of one rule; a field the library offers no value for cannot be chosen.
function FieldSelect({
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
  return (
    <select
      aria-label={label}
      value={rule.field}
      onChange={(event) => {
        const field = z.enum(RULE_FIELDS).parse(event.target.value);
        const changed = newRule(payload, field);
        if (changed === null) {
          throw new Error(`the ${field} field was offered with no value to choose`);
        }
        onChange(changed);
      }}
      className={INPUT}
    >
      {RULE_FIELDS.map((field) => (
        <option key={field} value={field} disabled={newRule(payload, field) === null}>
          {RULE_FIELD_LABELS[field]}
        </option>
      ))}
    </select>
  );
}

export default function SmartCollectionDialog({
  payload,
  initial,
  title,
  onSave,
  onClose,
}: SmartCollectionDialogProps) {
  const [draft, setDraft] = useState<SmartCollectionDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const setRule = (index: number, rule: Rule) =>
    setDraft({ ...draft, rules: draft.rules.map((old, at) => (at === index ? rule : old)) });
  const ready =
    draft.name.trim() !== "" &&
    draft.rules.length > 0 &&
    draft.rules.every((rule) => complete(payload, rule));
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
              setSaving(true);
              setRefusal(null);
              onSave(draft).then(onClose, (error: Error) => {
                setSaving(false);
                setRefusal(error.message);
              });
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
                  setDraft({
                    ...draft,
                    match: SavedSearchSchema.shape.match.parse(event.target.value),
                  })
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
                  <FieldSelect
                    payload={payload}
                    rule={rule}
                    label={`Rule ${index + 1} field`}
                    onChange={(changed) => setRule(index, changed)}
                  />
                  <select
                    aria-label={`Rule ${index + 1} operator`}
                    value={rule.operator}
                    onChange={(event) => setRule(index, withOperator(rule, event.target.value))}
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
              onClick={() => setDraft({ ...draft, rules: [...draft.rules, firstRule(payload)] })}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-medium hover:bg-surface"
            >
              <Plus className="h-4 w-4" /> Add Rule
            </button>
            {refusal !== null && (
              <p role="alert" className="text-danger">
                {refusal}
              </p>
            )}
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
                disabled={!ready || saving}
                className="rounded-lg bg-accent px-3.5 py-2 font-medium text-white disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
