import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CircleDashed,
  FileText,
  LoaderCircle,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import prettyBytes from "pretty-bytes";
import { type ReactNode, useState } from "react";
import type { BucketItem, Collection, Extraction, SourceCheck } from "../../contract/library";
import {
  dateTime,
  isTopic,
  shortDate,
  sourceCheckText,
  sourceDomain,
  thumbnailPath,
  topicName,
  topicTag,
} from "../format";
import type { ItemSourceActions, SendAttempt } from "../libraryActions";
import type { Related } from "../librarySelectors";
import { Chip, TagChip } from "./Chips";
import ExtractionRunner, { type ItemExtractionActions } from "./ExtractionRunner";
import { FilingPicker } from "./FilingEditors";

export type ItemFilingActions = {
  setTags: (tags: string[]) => void;
  setCollections: (collections: string[]) => void;
  // Creates a collection with this name and files the item in it.
  fileInNewCollection: (name: string) => void;
  addNote: (note: string) => void;
  deleteNote: (noteId: string) => void;
};

export type ItemSendActions = {
  attempt: SendAttempt | undefined;
  onSend: () => void;
};

type InspectorPanelProps = {
  item: BucketItem;
  related: Related[];
  onSelectItem: (id: string) => void;
  collections: Collection[];
  knownTags: string[];
  filing: ItemFilingActions;
  sources: ItemSourceActions & { verifying: boolean };
  send: ItemSendActions;
  extraction: ItemExtractionActions;
  onOpenReader: () => void;
  onClose: () => void;
};

function ArtifactRow({ name, path, sizeBytes }: { name: string; path: string; sizeBytes: number }) {
  return (
    <li className="flex items-center gap-2" title={path}>
      <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="min-w-0 truncate font-mono text-xs">{name}</span>
      <span className="ml-auto shrink-0 text-xs text-muted">{prettyBytes(sizeBytes)}</span>
    </li>
  );
}

// The Markdown and the artifacts an extraction plugin left beside the PDF.
function ExtractionFiles({ extraction }: { extraction: Extraction }) {
  if (extraction.status === "none") {
    return null;
  }
  return (
    <ul className="w-full space-y-1">
      <ArtifactRow {...extraction.markdown} />
      {extraction.files.map((file) => (
        <ArtifactRow key={file.name} {...file} />
      ))}
    </ul>
  );
}

const CHECK_MARKS: Record<SourceCheck["status"], { icon: ReactNode; label: string }> = {
  unchecked: { icon: <CircleDashed className="h-3.5 w-3.5 text-faint" />, label: "Not verified" },
  accessible: { icon: <Check className="h-3.5 w-3.5 text-ok" />, label: "Serves the PDF" },
  changed: {
    icon: <AlertTriangle className="h-3.5 w-3.5 text-warning" />,
    label: "Serves other bytes",
  },
  dead: { icon: <X className="h-3.5 w-3.5 text-danger" />, label: "Serves nothing" },
};

// A URL the PDF can be fetched from, with what its last check found.
function SourceLine({
  url,
  check,
  onRemove,
}: {
  url: string;
  check: SourceCheck;
  onRemove?: () => void;
}) {
  const mark = CHECK_MARKS[check.status];
  return (
    <li className="group flex min-w-0 items-center gap-1.5" title={sourceCheckText(check)}>
      <span aria-label={mark.label} className="shrink-0">
        {mark.icon}
      </span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 truncate text-xs text-accent hover:underline"
      >
        {url}
      </a>
      {onRemove !== undefined && (
        <button
          type="button"
          aria-label={`Remove mirror ${url}`}
          onClick={onRemove}
          className="ml-auto shrink-0 rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}

// The PDF URL and the mirrors, a field to add a mirror, and Verify.
function Sources({ item, sources }: { item: BucketItem; sources: InspectorPanelProps["sources"] }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="w-full space-y-2">
      <ul className="space-y-1">
        <SourceLine url={item.provenance.pdf_url} check={item.sourceCheck} />
        {item.mirrors.map((mirror) => (
          <SourceLine
            key={mirror.url}
            url={mirror.url}
            check={mirror.check}
            onRemove={() => sources.removeMirror(mirror.url)}
          />
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sources.addMirror(draft.trim());
          setDraft("");
        }}
      >
        <input
          type="url"
          aria-label="Mirror URL"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add mirror URL"
          className="w-full rounded-md border border-line px-2 py-1 text-xs outline-none placeholder:text-faint focus:border-accent"
        />
      </form>
      <button
        type="button"
        aria-label="Verify sources"
        onClick={sources.verify}
        disabled={sources.verifying}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:bg-surface disabled:opacity-60"
      >
        <RefreshCw
          aria-hidden
          className={`h-3.5 w-3.5 ${sources.verifying ? "animate-spin" : ""}`}
        />
        Verify
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </>
  );
}

function Details({
  item,
  collections,
  knownTags,
  filing,
  extraction,
  ...props
}: Omit<InspectorPanelProps, "send" | "onOpenReader" | "onClose">) {
  const names = new Map(collections.map((collection) => [collection.id, collection.name]));
  const topics = item.tags.filter(isTopic);
  const tags = item.tags.filter((tag) => !isTopic(tag));
  const without = (tag: string) =>
    filing.setTags(item.tags.filter((candidate) => candidate !== tag));
  const addTag = (tag: string) => {
    if (!item.tags.includes(tag)) {
      filing.setTags([...item.tags, tag]);
    }
  };
  const asOptions = (values: string[]) => values.map((value) => ({ id: value, name: value }));

  return (
    <>
      {/* A fixed height: the image loads after the panel draws, and must not push the fields down. */}
      <img
        src={thumbnailPath(item.id, 640)}
        alt="First page"
        className="mx-4 mt-4 h-64 w-[calc(100%-2rem)] rounded border border-line bg-panel object-cover object-top"
      />
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 px-4 py-4 text-sm">
        <Row label="Collections">
          {item.collections.map((id) => (
            <Chip
              key={id}
              label={names.get(id) ?? id}
              kind="collection"
              onRemove={() =>
                filing.setCollections(item.collections.filter((candidate) => candidate !== id))
              }
            />
          ))}
          <FilingPicker
            label="collection"
            options={collections.filter((collection) => !item.collections.includes(collection.id))}
            onPick={(id) => filing.setCollections([...item.collections, id])}
            onCreate={filing.fileInNewCollection}
          />
        </Row>
        <Row label="Topics">
          {topics.map((tag) => (
            <TagChip key={tag} tag={tag} onRemove={() => without(tag)} />
          ))}
          <FilingPicker
            label="topic"
            options={asOptions(
              knownTags
                .filter(isTopic)
                .filter((tag) => !topics.includes(tag))
                .map(topicName),
            )}
            onPick={(name) => addTag(topicTag(name))}
            onCreate={(name) => addTag(topicTag(name))}
          />
        </Row>
        <Row label="Tags">
          {tags.map((tag) => (
            <TagChip key={tag} tag={tag} onRemove={() => without(tag)} />
          ))}
          <FilingPicker
            label="tag"
            options={asOptions(knownTags.filter((tag) => !isTopic(tag) && !tags.includes(tag)))}
            onPick={addTag}
            onCreate={addTag}
          />
        </Row>
        <Row label="Sources">
          <Sources item={item} sources={props.sources} />
        </Row>
        <Row label="Extraction">
          <div className="w-full space-y-2">
            <ExtractionFiles extraction={item.extraction} />
            <ExtractionRunner {...extraction} />
          </div>
        </Row>
      </dl>
    </>
  );
}

function Notes({ item, filing }: { item: BucketItem; filing: ItemFilingActions }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="space-y-3 px-4 py-4">
      {item.notes.map((note) => (
        <article key={note.id} className="group rounded-lg bg-note px-3.5 py-3 text-sm">
          <p className="whitespace-pre-wrap text-ink">{note.note}</p>
          <footer className="mt-2 flex items-center justify-between text-xs text-muted">
            <time dateTime={note.dateAdded}>{dateTime(note.dateAdded)}</time>
            <button
              type="button"
              aria-label="Delete note"
              onClick={() => filing.deleteNote(note.id)}
              className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-note-hover"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </footer>
        </article>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          filing.addNote(draft);
          setDraft("");
        }}
        className="space-y-2"
      >
        <textarea
          aria-label="New note"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          className="w-full resize-y rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Add note
        </button>
      </form>
    </div>
  );
}

// What each related item shares with this one; a click selects it.
function RelatedList({
  related,
  collections,
  onSelect,
}: {
  related: Related[];
  collections: Collection[];
  onSelect: (id: string) => void;
}) {
  if (related.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted">
        No other PDF shares an author, collection, topic or tag.
      </p>
    );
  }
  const names = new Map(collections.map((collection) => [collection.id, collection.name]));
  return (
    <ul className="divide-y divide-line">
      {related.map((entry) => (
        <li key={entry.item.id}>
          <button
            type="button"
            data-related-id={entry.item.id}
            onClick={() => onSelect(entry.item.id)}
            className="w-full px-4 py-2.5 text-left hover:bg-surface"
          >
            <span className="block truncate text-sm font-medium text-ink">{entry.item.title}</span>
            <span className="mt-1 flex flex-wrap gap-1">
              {entry.authors.map((author) => (
                <span key={author} className="text-xs text-muted">
                  {author}
                </span>
              ))}
              {entry.collections.map((id) => (
                <Chip key={id} label={names.get(id) ?? id} kind="collection" />
              ))}
              {entry.tags.map((tag) => (
                <TagChip key={tag} tag={tag} />
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// A send that failed or was refused; a completed send takes the item out of the bucket.
function SendNotice({ attempt }: { attempt: SendAttempt | undefined }) {
  if (attempt?.kind !== "refused" && attempt?.kind !== "failed") {
    return null;
  }
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{attempt.message}</span>
    </p>
  );
}

const TAB_CLASSES =
  "border-b-2 border-transparent px-1 pb-2 text-sm font-medium text-muted data-[state=active]:border-accent data-[state=active]:text-accent";

export default function InspectorPanel(props: InspectorPanelProps) {
  const { item, send, onOpenReader, onClose } = props;
  const sending = send.attempt?.kind === "sending";
  // Sent with every step done: the item stays only because a collection keeps it offline.
  const inZotero = item.zotero.status === "sent" && item.zotero.pending.length === 0;
  return (
    <aside
      aria-label="Item details"
      className="flex h-full min-h-0 flex-col border-l border-line bg-panel"
    >
      <header className="flex items-start gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base leading-snug font-semibold text-ink">{item.title}</h2>
          {(item.authors.length > 0 || item.year !== null) && (
            <p className="mt-0.5 text-sm text-ink/80">
              {[item.authors.join(", "), item.year]
                .filter((part) => part !== null && part !== "")
                .join(" · ")}
            </p>
          )}
          {item.abstract !== null && (
            <details className="mt-1.5 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-accent">Abstract</summary>
              <p className="mt-1 max-h-48 overflow-y-auto text-ink/80">{item.abstract}</p>
            </details>
          )}
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <a
              href={item.provenance.source_url}
              target="_blank"
              rel="noreferrer"
              title={item.provenance.source_url}
              className="text-accent hover:underline"
            >
              {sourceDomain(item.provenance.source_url)}
            </a>
            <span aria-hidden>·</span>
            <span title={dateTime(item.dateAdded)}>{shortDate(item.dateAdded)}</span>
            <span aria-hidden>·</span>
            <span>{prettyBytes(item.file.sizeBytes)}</span>
          </p>
        </div>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-surface hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <Tabs.Root defaultValue="details" className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="mt-3 flex gap-4 border-b border-line px-4">
          <Tabs.Trigger value="details" className={TAB_CLASSES}>
            Details
          </Tabs.Trigger>
          <Tabs.Trigger value="notes" className={TAB_CLASSES}>
            Notes{item.notes.length > 0 && ` (${item.notes.length})`}
          </Tabs.Trigger>
          <Tabs.Trigger value="related" className={TAB_CLASSES}>
            Related ({props.related.length})
          </Tabs.Trigger>
        </Tabs.List>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Tabs.Content value="details">
            <Details {...props} />
          </Tabs.Content>
          <Tabs.Content value="notes">
            <Notes item={item} filing={props.filing} />
          </Tabs.Content>
          <Tabs.Content value="related">
            <RelatedList
              related={props.related}
              collections={props.collections}
              onSelect={props.onSelectItem}
            />
          </Tabs.Content>
        </div>
      </Tabs.Root>
      <footer className="space-y-2 border-t border-line px-4 py-3">
        <SendNotice attempt={send.attempt} />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onOpenReader}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <BookOpen className="h-4 w-4" /> Open
          </button>
          <button
            type="button"
            onClick={send.onSend}
            disabled={sending || inZotero}
            className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-60"
          >
            {sending ? (
              <LoaderCircle aria-hidden className="h-4 w-4 animate-spin text-accent" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {inZotero ? "In Zotero" : "Send to Zotero"}
          </button>
        </div>
      </footer>
    </aside>
  );
}
