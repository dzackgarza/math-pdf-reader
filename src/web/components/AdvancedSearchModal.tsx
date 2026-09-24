import * as Dialog from "@radix-ui/react-dialog";
import { SlidersHorizontal, X } from "lucide-react";
import {
  type AdvancedSearchSettings,
  type BucketItem,
  SEARCH_FIELDS,
} from "../../server/libraryContract";
import { filterItems, SEARCH_FIELD_LABELS } from "../search";

type AdvancedSearchModalProps = {
  open: boolean;
  onClose: () => void;
  settings: AdvancedSearchSettings;
  onChange: (settings: AdvancedSearchSettings) => void;
  items: BucketItem[];
};

const MATCH_TYPES = [
  { value: "all", label: "All words" },
  { value: "any", label: "Any word" },
] as const;

export default function AdvancedSearchModal({
  open,
  onClose,
  settings,
  onChange,
  items,
}: AdvancedSearchModalProps) {
  const matching = filterItems(items, settings).length;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel shadow-2xl outline-none"
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
              <SlidersHorizontal className="h-4 w-4 text-accent" /> Filters
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close filters"
              className="rounded p-1 text-muted hover:bg-surface"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="space-y-5 px-5 py-5 text-sm">
            <label className="block">
              <span className="mb-1.5 block font-medium">Search for</span>
              <input
                value={settings.query}
                onChange={(event) => onChange({ ...settings, query: event.target.value })}
                placeholder="Every PDF"
                className="w-full rounded-lg border border-line px-3 py-2 outline-none focus:border-accent"
              />
            </label>
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex gap-1 rounded-lg bg-surface p-1">
                {MATCH_TYPES.map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => onChange({ ...settings, matchType: type.value })}
                    className={`rounded-md px-3 py-1 ${
                      settings.matchType === type.value
                        ? "bg-panel font-medium shadow-sm"
                        : "text-muted"
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.matchCase}
                  onChange={(event) => onChange({ ...settings, matchCase: event.target.checked })}
                  className="accent-accent"
                />
                Match case
              </label>
            </div>
            <fieldset>
              <legend className="mb-2 font-medium">Search in</legend>
              <div className="grid grid-cols-2 gap-2">
                {SEARCH_FIELDS.map((field) => (
                  <label key={field} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.searchFields[field]}
                      onChange={(event) =>
                        onChange({
                          ...settings,
                          searchFields: { ...settings.searchFields, [field]: event.target.checked },
                        })
                      }
                      className="accent-accent"
                    />
                    {SEARCH_FIELD_LABELS[field]}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="rounded-lg bg-surface px-3 py-2 text-muted">
              Matches <strong className="text-ink">{matching}</strong> of {items.length} PDFs.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
