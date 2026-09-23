import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  Send,
  Trash2,
  X,
} from "lucide-react";
import prettyBytes from "pretty-bytes";
import { type ReactNode, useState } from "react";
import type {
  BucketItem,
  Collection,
  Extraction,
  SendSource,
  ZoteroStatus,
} from "../../server/libraryContract";
import { dateTime, isTopic, shortDate, sourceDomain, topicName, topicTag } from "../format";
import type { SendAttempt } from "../libraryActions";
import { Chip, TagChip } from "./Chips";
import { AddByName, AddToCollection } from "./FilingEditors";

export type ItemFilingActions = {
  setTags: (tags: string[]) => void;
  setCollections: (collections: string[]) => void;
  addNote: (note: string) => void;
  deleteNote: (noteId: string) => void;
};

export type ItemSendActions = {
  attempt: SendAttempt | null;
  onSend: () => void;
  onRemove: () => void;
};

type InspectorPanelProps = {
  item: BucketItem;
  collections: Collection[];
  knownTags: string[];
  filing: ItemFilingActions;
  send: ItemSendActions;
  onOpenReader: () => void;
  onClose: () => void;
};

type CopyState = { kind: "idle" } | { kind: "copied" } | { kind: "failed"; message: string };

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<CopyState>({ kind: "idle" });
  const copy = () => {
    navigator.clipboard.writeText(value).then(
      () => setState({ kind: "copied" }),
      (error: Error) => setState({ kind: "failed", message: error.message }),
    );
  };
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={state.kind === "failed" ? `Copy failed: ${state.message}` : `Copy ${label}`}
      onClick={copy}
      className={`shrink-0 rounded p-1 hover:bg-surface ${state.kind === "failed" ? "text-red-600" : "text-faint hover:text-ink"}`}
    >
      {state.kind === "copied" ? (
        <Check className="h-3.5 w-3.5 text-filed" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">{children}</dd>
    </>
  );
}

function ExternalLinkText({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 truncate text-accent hover:underline"
      title={url}
    >
      {url}
    </a>
  );
}

// A hash is recognisable by its ends; the full value is one click away.
function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

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
    return <span className="text-muted">None yet</span>;
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

// Where the item's Zotero metadata came from.
function sendSourceLabel(source: SendSource): string {
  return source.kind === "manuscript"
    ? "Manuscript: no identifier found"
    : `${source.pluginId} resolver on ${source.identifier}`;
}

function ZoteroFact({ zotero }: { zotero: ZoteroStatus }) {
  if (zotero.status === "unsent") {
    return <span className="text-muted">Not sent</span>;
  }
  const { itemKey, sentAt, source } = zotero.record;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs">{itemKey}</span>
        <CopyButton value={itemKey} label="Zotero item key" />
        <span className="text-muted">· {shortDate(sentAt)}</span>
      </div>
      <p className="truncate text-xs text-muted" title={sendSourceLabel(source)}>
        {sendSourceLabel(source)}
      </p>
      {zotero.pending.length > 0 && (
        <p className="text-xs text-amber-700">Still to send: {zotero.pending.join(", ")}</p>
      )}
    </div>
  );
}

function FilingRow({ label, children }: { label: string; children: ReactNode }) {
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
}: Omit<InspectorPanelProps, "send" | "onOpenReader" | "onClose">) {
  const { provenance } = item;
  const names = new Map(collections.map((collection) => [collection.id, collection.name]));
  const topics = item.tags.filter(isTopic);
  const tags = item.tags.filter((tag) => !isTopic(tag));
  const without = (tag: string) =>
    filing.setTags(item.tags.filter((candidate) => candidate !== tag));
  const addTag = (tag: string) => filing.setTags([...item.tags, tag]);

  return (
    <div className="space-y-6 px-5 py-5">
      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
        <Fact label="Source">
          <span className="font-medium">{sourceDomain(item.url)}</span>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs font-medium hover:bg-surface"
          >
            Visit source <ExternalLink className="h-3 w-3" />
          </a>
        </Fact>
        <Fact label="Source URL">
          <ExternalLinkText url={provenance.source_url} />
          <CopyButton value={provenance.source_url} label="source URL" />
        </Fact>
        <Fact label="PDF URL">
          <ExternalLinkText url={provenance.pdf_url} />
          <CopyButton value={provenance.pdf_url} label="PDF URL" />
        </Fact>
        <Fact label="First captured">{dateTime(provenance.captured_at)}</Fact>
        <Fact label="File path">
          <span className="min-w-0 truncate font-mono text-xs" title={item.file.path}>
            {item.file.path}
          </span>
          <CopyButton value={item.file.path} label="file path" />
        </Fact>
        <Fact label="Cache status">
          <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-filed" />
          Stored locally ({prettyBytes(item.file.sizeBytes)})
        </Fact>
        <Fact label="Zotero">
          <ZoteroFact zotero={item.zotero} />
        </Fact>
        <Fact label="SHA-256">
          <span className="font-mono text-xs" title={provenance.original_sha256}>
            {shortHash(provenance.original_sha256)}
          </span>
          <CopyButton value={provenance.original_sha256} label="original SHA-256" />
        </Fact>
      </dl>

      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 border-t border-line pt-5 text-sm">
        <FilingRow label="Collections">
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
          <AddToCollection
            collections={collections.filter(
              (collection) => !item.collections.includes(collection.id),
            )}
            onAdd={(id) => filing.setCollections([...item.collections, id])}
          />
        </FilingRow>
        <FilingRow label="Topics">
          {topics.map((tag) => (
            <TagChip key={tag} tag={tag} onRemove={() => without(tag)} />
          ))}
          <AddByName
            label="Add topic"
            suggestions={knownTags.filter(isTopic).map(topicName)}
            onAdd={(name) => addTag(topicTag(name))}
          />
        </FilingRow>
        <FilingRow label="Tags">
          {tags.map((tag) => (
            <TagChip key={tag} tag={tag} onRemove={() => without(tag)} />
          ))}
          <AddByName
            label="Add tag"
            suggestions={knownTags.filter((tag) => !isTopic(tag))}
            onAdd={addTag}
          />
        </FilingRow>
        <FilingRow label="Extraction">
          <ExtractionFiles extraction={item.extraction} />
        </FilingRow>
      </dl>
    </div>
  );
}

function Notes({ item, filing }: { item: BucketItem; filing: ItemFilingActions }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="space-y-3 px-5 py-5">
      {item.notes.length === 0 && <p className="text-sm text-muted">No notes on this PDF yet.</p>}
      {item.notes.map((note) => (
        <article key={note.id} className="group rounded-lg bg-amber-50 px-3.5 py-3 text-sm">
          <p className="whitespace-pre-wrap text-ink">{note.note}</p>
          <footer className="mt-2 flex items-center justify-between text-xs text-muted">
            <time dateTime={note.dateAdded}>{dateTime(note.dateAdded)}</time>
            <button
              type="button"
              aria-label="Delete note"
              onClick={() => filing.deleteNote(note.id)}
              className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-amber-100"
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
          placeholder="Add a note…"
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

function isComplete(zotero: ZoteroStatus): boolean {
  return zotero.status === "sent" && zotero.pending.length === 0;
}

// The outcome of the last send, or the item's place in Zotero once every step is done.
function SendNotice({ item, attempt }: { item: BucketItem; attempt: SendAttempt | null }) {
  if (attempt?.kind === "refused" || attempt?.kind === "failed") {
    const refused = attempt.kind === "refused";
    return (
      <p
        role="alert"
        className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${refused ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-800"}`}
      >
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">
          {refused ? "Not sent again: " : "Send failed: "}
          {attempt.message}
        </span>
      </p>
    );
  }
  if (item.zotero.status === "sent" && isComplete(item.zotero)) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-filed-soft px-3 py-2 text-sm text-filed">
        <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
        In Zotero as <span className="font-mono text-xs">{item.zotero.record.itemKey}</span>
      </p>
    );
  }
  return null;
}

const SECONDARY_BUTTON =
  "inline-flex items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm font-medium disabled:opacity-60";

function SendButton({ item, send }: { item: BucketItem; send: ItemSendActions }) {
  if (isComplete(item.zotero)) {
    return (
      <button
        type="button"
        onClick={send.onRemove}
        className={`${SECONDARY_BUTTON} text-red-700 hover:bg-red-50`}
      >
        <Trash2 className="h-4 w-4" /> Remove from bucket
      </button>
    );
  }
  if (send.attempt?.kind === "sending") {
    return (
      <button type="button" disabled className={SECONDARY_BUTTON}>
        <LoaderCircle aria-hidden className="h-4 w-4 animate-spin text-accent" /> Sending to Zotero…
      </button>
    );
  }
  return (
    <button type="button" onClick={send.onSend} className={`${SECONDARY_BUTTON} hover:bg-surface`}>
      <Send className="h-4 w-4" />
      {item.zotero.status === "sent" ? "Finish sending to Zotero" : "Send to Zotero"}
    </button>
  );
}

const TAB_CLASSES =
  "border-b-2 border-transparent px-1 pb-2.5 text-sm font-medium text-muted data-[state=active]:border-accent data-[state=active]:text-accent";

export default function InspectorPanel(props: InspectorPanelProps) {
  const { item, onOpenReader, onClose } = props;
  return (
    <aside
      aria-label="Item details"
      className="flex h-full min-h-0 flex-col border-l border-line bg-white"
    >
      <Tabs.Root defaultValue="details" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 pt-3">
          <Tabs.List className="flex gap-5">
            <Tabs.Trigger value="details" className={TAB_CLASSES}>
              Details
            </Tabs.Trigger>
            <Tabs.Trigger value="notes" className={TAB_CLASSES}>
              Notes ({item.notes.length})
            </Tabs.Trigger>
          </Tabs.List>
          <button
            type="button"
            aria-label="Close details"
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-surface hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <header className="px-5 pt-5">
          <h2 className="text-base leading-snug font-semibold text-ink">{item.title}</h2>
          <p className="mt-1 text-sm text-muted">
            Captured {shortDate(item.dateAdded)} from {sourceDomain(item.url)}
          </p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Tabs.Content value="details">
            <Details {...props} />
          </Tabs.Content>
          <Tabs.Content value="notes">
            <Notes item={item} filing={props.filing} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
      <footer className="space-y-3 border-t border-line px-5 py-4">
        <SendNotice item={item} attempt={props.send.attempt} />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onOpenReader}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <BookOpen className="h-4 w-4" /> Open Reader
          </button>
          <SendButton item={item} send={props.send} />
        </div>
      </footer>
    </aside>
  );
}
