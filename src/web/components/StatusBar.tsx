import { Archive, HardDrive, Radio } from "lucide-react";
import prettyBytes from "pretty-bytes";
import { useEffect, useState } from "react";
import { type IndexExportState, IndexExportStateSchema } from "../../contract/capture";
import type { LibraryPayload } from "../../contract/library";
import type { StatusRead } from "../useBucketStatus";

// Whether browser captures can land: the one state worth a glance, detailed on hover.
function CaptureIndicator({ read }: { read: StatusRead }) {
  const [color, title] =
    read.kind === "checking"
      ? ["text-faint", "Checking…"]
      : read.kind === "failed"
        ? ["text-danger", `Cannot tell whether captures can land: ${read.message}`]
        : read.status.ready
          ? ["text-ok", "Capturing PDFs from the browser"]
          : [
              "text-danger",
              `Not capturing: ${read.status.root} ${read.status.storage.root_exists ? "is not writable" : "does not exist"}`,
            ];
  return (
    <span role="status" aria-label={title} title={title} className={`ml-auto ${color}`}>
      <Radio aria-hidden className="h-3.5 w-3.5" />
    </span>
  );
}

// The index export's state as the bucket streams it (`index-export` on /api/events, the
// current state first).
function useIndexExport(): IndexExportState | null {
  const [state, setState] = useState<IndexExportState | null>(null);
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("index-export", (event: MessageEvent<string>) => {
      setState(IndexExportStateSchema.parse(JSON.parse(event.data)));
    });
    return () => events.close();
  }, []);
  return state;
}

function exportSummary(state: IndexExportState): [string, string] {
  switch (state.status) {
    case "pending":
      return ["text-faint", `Writing the index export to ${state.file}…`];
    case "written":
      return ["text-muted", `Index export of ${state.items} items written to ${state.file}`];
    case "refused":
      return [
        "text-danger",
        `The index export is not updated: it lists ${state.missing.join(", ")}, whose PDFs are gone. Rebuild them from Needs Re-fetch, or forget them (pdf-bucket forget <key>).`,
      ];
    case "failed":
      return ["text-danger", `The index export failed: ${state.message}`];
  }
}

// Whether the backup export that can rebuild the library is current; a refused or failed export
// shows its reason in the bar itself.
function ExportIndicator() {
  const state = useIndexExport();
  if (state === null) {
    return null;
  }
  const [color, title] = exportSummary(state);
  const failing = state.status === "refused" || state.status === "failed";
  return (
    <span role="status" aria-label={title} title={title} className={`flex min-w-0 items-center gap-1.5 ${color}`}>
      <Archive aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {failing && <span className="truncate">{title}</span>}
    </span>
  );
}

export default function StatusBar({
  payload,
  read,
}: {
  payload: LibraryPayload;
  read: StatusRead;
}) {
  const stored = payload.items.reduce((total, item) => total + item.file.sizeBytes, 0);
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-xs text-muted">
      <span title="On disk" className="flex items-center gap-1.5 tabular-nums">
        <HardDrive aria-hidden className="h-3.5 w-3.5" />
        {prettyBytes(stored)}
      </span>
      <ExportIndicator />
      <CaptureIndicator read={read} />
    </footer>
  );
}
