// Tag, topic and collection pills, shared by the table and the inspector.
import { X } from "lucide-react";
import { isTopic, topicName } from "../format";

export type ChipKind = "tag" | "topic" | "collection";

const CHIP_CLASSES: Record<ChipKind, string> = {
  tag: "bg-accent-soft text-accent",
  topic: "bg-topic-soft text-topic",
  collection: "bg-filed-soft text-filed",
};

export function Chip({
  label,
  kind,
  onRemove,
}: {
  label: string;
  kind: ChipKind;
  onRemove?: () => void;
}) {
  return (
    <span
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
