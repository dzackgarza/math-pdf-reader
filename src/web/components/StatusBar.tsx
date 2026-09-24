import { FileText, HardDrive, Inbox, Radio } from "lucide-react";
import prettyBytes from "pretty-bytes";
import type { ReactNode } from "react";
import type { LibraryPayload } from "../../server/libraryContract";
import { itemsInView } from "../librarySelectors";
import type { StatusRead } from "../useBucketStatus";

function Count({ icon, value, title }: { icon: ReactNode; value: string; title: string }) {
  return (
    <span title={title} className="flex items-center gap-1.5 tabular-nums">
      {icon}
      {value}
    </span>
  );
}

// Whether browser captures can land: the one state worth a glance, detailed on hover.
function CaptureIndicator({ read }: { read: StatusRead }) {
  const [color, title] =
    read.kind === "checking"
      ? ["text-faint", "Checking…"]
      : read.kind === "failed"
        ? ["text-red-600", `Not capturing: ${read.message}`]
        : read.status.ready
          ? ["text-green-600", "Capturing PDFs from the browser"]
          : ["text-red-600", `Not capturing: ${read.status.root} is not writable`];
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
  const unfiled = itemsInView(payload, { kind: "unfiled" }).length;
  const icon = "h-3.5 w-3.5";
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-xs text-muted">
      <Count
        icon={<FileText aria-hidden className={icon} />}
        value={payload.items.length.toLocaleString()}
        title="PDFs"
      />
      <Count
        icon={<HardDrive aria-hidden className={icon} />}
        value={prettyBytes(stored)}
        title="On disk"
      />
      <Count
        icon={<Inbox aria-hidden className={icon} />}
        value={unfiled.toLocaleString()}
        title="Unfiled"
      />
      <CaptureIndicator read={read} />
    </footer>
  );
}
