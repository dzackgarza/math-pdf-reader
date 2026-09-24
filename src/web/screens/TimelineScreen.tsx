// The Timeline: what was read and when, newest first, as daisyUI's vertical timeline with the
// icon snapped to the start. Each entry is one paper's reading (reopenings within half an hour
// joined), with its title linking back to the reader, authors, year, the pages read and the
// abstract when known. A minimum reading time hides short looks.
import { BookOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { type ReadingSession, ReadingSessionSchema } from "../../server/libraryContract";
import { dateTime } from "../format";
import { pageRanges, timelineEntries } from "../timeline";

const MINIMUMS: [number, string][] = [
  [5, "Any page read"],
  [30, "30 seconds"],
  [120, "2 minutes"],
  [600, "10 minutes"],
];

function duration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function timeRange(openedAt: string, lastSeenAt: string): string {
  const until = new Date(lastSeenAt).toLocaleTimeString("en-US", { timeStyle: "short" });
  return `${dateTime(openedAt)} – ${until}`;
}

type TimelineScreenProps = {
  // Keys of the PDFs the bucket holds; a title links to the reader for these, to the source
  // page for a PDF that has left.
  stored: ReadonlySet<string>;
  onError: (message: string) => void;
};

export default function TimelineScreen({ stored, onError }: TimelineScreenProps) {
  const [sessions, setSessions] = useState<ReadingSession[] | null>(null);
  const [minimum, setMinimum] = useState(30);
  useEffect(() => {
    fetch("/api/reading-sessions")
      .then(async (response) => ReadingSessionSchema.array().parse(await response.json()))
      .then(setSessions, (error: Error) => onError(error.message));
  }, [onError]);
  const entries = sessions === null ? [] : timelineEntries(sessions, minimum);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-5 flex items-center gap-3 text-sm">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <label className="ml-auto flex items-center gap-2 text-muted">
          Shortest reading
          <select
            aria-label="Shortest reading"
            value={minimum}
            onChange={(event) => setMinimum(Number(event.target.value))}
            className="rounded-md border border-line bg-white px-2 py-1 text-ink"
          >
            {MINIMUMS.map(([seconds, label]) => (
              <option key={seconds} value={seconds}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {sessions !== null && entries.length === 0 && (
        <p className="py-10 text-center text-sm text-muted">No reading to show.</p>
      )}
      <ul className="timeline timeline-snap-icon timeline-vertical max-md:timeline-compact">
        {entries.map((entry, index) => {
          const side = index % 2 === 0 ? "timeline-start md:text-end" : "timeline-end";
          const href = stored.has(entry.key)
            ? `/read/${encodeURIComponent(entry.key)}`
            : entry.item.sourceUrl;
          const byline = [entry.item.authors.join(", "), entry.item.year]
            .filter((part) => part !== null && part !== "")
            .join(" · ");
          return (
            <li key={`${entry.key}-${entry.openedAt}`} data-timeline-key={entry.key}>
              {index > 0 && <hr />}
              <div className="timeline-middle text-accent">
                <BookOpen aria-hidden className="h-5 w-5" />
              </div>
              <div className={`${side} mb-8 max-w-xl`}>
                <time dateTime={entry.openedAt} className="font-mono text-xs text-muted italic">
                  {timeRange(entry.openedAt, entry.lastSeenAt)}
                </time>
                <a href={href} className="block text-base font-semibold text-ink hover:text-accent">
                  {entry.item.title}
                </a>
                {byline !== "" && <p className="text-sm text-ink/80">{byline}</p>}
                <p className="text-xs text-muted">
                  Read {duration(entry.seconds)} · pp. {pageRanges(entry.pages)}
                  {entry.sessions > 1 && ` · ${entry.sessions} sessions`}
                </p>
                {entry.item.abstract !== null && (
                  <details className="mt-1 text-sm">
                    <summary className="cursor-pointer text-xs font-medium text-accent">
                      Abstract
                    </summary>
                    <p className="mt-1 text-left text-ink/80">{entry.item.abstract}</p>
                  </details>
                )}
              </div>
              {index < entries.length - 1 && <hr />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
