// The collections as cards: name, how many PDFs they hold (subcollections included), the
// description, the most used tags, and a pin that brings a card to the front.
import { Folder, FolderOpen, Pin } from "lucide-react";
import { Link } from "wouter";
import type { Collection, LibraryPayload } from "../../server/libraryContract";
import { pdfCount } from "../format";
import { itemsInView, tagCounts } from "../librarySelectors";
import { organizationPath } from "../routes";
import { TagChip } from "./Chips";

type CollectionCardsProps = {
  payload: LibraryPayload;
  entry: string | null;
  onPin: (collection: Collection, pinned: boolean) => void;
};

export default function CollectionCards({ payload, entry, onPin }: CollectionCardsProps) {
  const roots = payload.collections
    .filter((collection) => collection.parentId === undefined)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
      {roots.map((collection) => {
        const items = itemsInView(payload, { kind: "collection", id: collection.id });
        const tags = tagCounts(items);
        const selected = collection.id === entry;
        return (
          <li
            key={collection.id}
            data-collection-id={collection.id}
            data-collection-name={collection.name}
            className={`relative rounded-xl border p-3.5 ${
              selected ? "border-accent bg-accent-soft/40" : "border-line bg-white hover:bg-surface"
            }`}
          >
            <Link href={organizationPath("collections", collection.id)} className="block">
              <span className="flex items-start gap-3">
                {selected ? (
                  <FolderOpen aria-hidden className="mt-0.5 h-7 w-7 shrink-0 text-accent" />
                ) : (
                  <Folder aria-hidden className="mt-0.5 h-7 w-7 shrink-0 text-accent" />
                )}
                <span className="min-w-0 flex-1 pr-6">
                  <span className="block truncate font-semibold text-ink">{collection.name}</span>
                  <span className="block text-xs text-muted">{pdfCount(items.length)}</span>
                </span>
              </span>
              <span className="mt-2 line-clamp-2 block min-h-[2.5em] text-sm text-muted">
                {collection.description}
              </span>
              <span className="mt-2 flex min-h-6 items-center gap-1 overflow-hidden">
                {tags.slice(0, 2).map(([tag]) => (
                  <TagChip key={tag} tag={tag} />
                ))}
                {tags.length > 2 && (
                  <span className="rounded-full bg-surface px-1.5 py-0.5 text-xs text-muted">
                    +{tags.length - 2}
                  </span>
                )}
              </span>
            </Link>
            <button
              type="button"
              aria-label={collection.pinned ? "Unpin" : "Pin"}
              title={collection.pinned ? "Unpin" : "Pin to the front"}
              aria-pressed={collection.pinned}
              onClick={() => onPin(collection, !collection.pinned)}
              className={`absolute top-3 right-3 rounded p-1 hover:bg-white ${
                collection.pinned ? "text-accent" : "text-faint hover:text-ink"
              }`}
            >
              <Pin className={`h-4 w-4 ${collection.pinned ? "fill-current" : ""}`} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
