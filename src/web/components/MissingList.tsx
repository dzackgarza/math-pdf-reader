// The lost PDFs: items the index export holds whose PDF the store no longer has, each with
// the URLs Rebuild will try.
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { MissingItem } from "../../contract/library";
import { shortDate } from "../format";

type MissingListProps = {
  missing: MissingItem[];
  rebuilding: ReadonlySet<string>;
  onRebuild: (key: string) => void;
  onRebuildAll: () => void;
};

export default function MissingList({
  missing,
  rebuilding,
  onRebuild,
  onRebuildAll,
}: MissingListProps) {
  if (missing.length === 0) {
    return (
      <p className="px-6 py-20 text-center text-sm text-muted">Every PDF is in the library.</p>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex justify-end px-4 py-2">
        <button
          type="button"
          onClick={onRebuildAll}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface"
        >
          <RotateCcw className="h-4 w-4" /> Rebuild all
        </button>
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {missing.map((item) => (
          <li
            key={item.key}
            data-missing-key={item.key}
            className="flex items-center gap-4 px-4 py-2.5 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink">{item.title}</p>
              <p className="truncate text-xs text-muted" title={item.provenance.pdf_url}>
                {item.provenance.pdf_url}
                {item.mirrors.length > 0 &&
                  ` and ${item.mirrors.length} mirror${item.mirrors.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted">
              {shortDate(item.provenance.captured_at)}
            </span>
            <button
              type="button"
              aria-label="Rebuild"
              title="Download the PDF again from its URL or a mirror"
              disabled={rebuilding.has(item.key)}
              onClick={() => onRebuild(item.key)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:bg-surface disabled:opacity-60"
            >
              {rebuilding.has(item.key) ? (
                <LoaderCircle aria-hidden className="h-4 w-4 animate-spin text-accent" />
              ) : (
                <RotateCcw aria-hidden className="h-4 w-4" />
              )}
              Rebuild
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
