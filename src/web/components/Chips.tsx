// Tag, topic and collection pills, shared by the table and the inspector.
import { X } from "lucide-react";
import { isTopic, topicName } from "../format";

export type ChipKind = "tag" | "topic" | "collection" | "deletedCollection";

const CHIP_CLASSES: Record<ChipKind, string> = {
  tag: "bg-accent-soft text-accent",
  topic: "bg-topic-soft text-topic",
  collection: "bg-filed-soft text-filed",
  deletedCollection: "bg-danger-soft text-danger italic",
};

export function Chip({
  label,
  kind,
  title,
  onRemove,
}: {
  label: string;
  kind: ChipKind;
  title?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_CLASSES[kind]}`}
    >
      <span className="truncate">{label}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="-mr-1 rounded-full p-0.5 opacity-60 hover:bg-ink/5 hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

// A tag as a pill: topics show their name without the namespace, in the topic colour.
export function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  return isTopic(tag) ? (
    <Chip label={topicName(tag)} kind="topic" onRemove={onRemove} />
  ) : (
    <Chip label={tag} kind="tag" onRemove={onRemove} />
  );
}

// A collection the item is filed in, by its name in NAMES; an id NAMES lacks is a collection
// deleted since (in another window, or by an older filing), shown as such with its id.
export function CollectionChip({
  id,
  names,
  onRemove,
}: {
  id: string;
  names: ReadonlyMap<string, string>;
  onRemove?: () => void;
}) {
  const name = names.get(id);
  return name === undefined ? (
    <Chip
      label="Deleted collection"
      kind="deletedCollection"
      title={`No collection has id ${id}`}
      onRemove={onRemove}
    />
  ) : (
    <Chip label={name} kind="collection" onRemove={onRemove} />
  );
}
