import { HardDrive, Radio } from "lucide-react";
import prettyBytes from "pretty-bytes";
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
      <CaptureIndicator read={read} />
    </footer>
  );
}
