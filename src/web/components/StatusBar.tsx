import { HardDrive } from "lucide-react";
import type { LibraryPayload } from "../../server/libraryContract";
import { fileSize } from "../format";
import { itemsInView } from "../librarySelectors";
import type { StatusRead } from "../useBucketStatus";

function BucketState({ read }: { read: StatusRead }) {
  if (read.kind === "checking") {
    return <span className="ml-auto">Checking the bucket…</span>;
  }
  if (read.kind === "failed") {
    return <span className="ml-auto text-red-700">Bucket status unavailable: {read.message}</span>;
  }
  const { status } = read;
  return (
    <span className="ml-auto flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${status.ready ? "bg-green-600" : "bg-red-600"}`} />
      {status.ready ? "Bucket ready" : "Bucket not ready"} at {new URL(status.backend_url).host}
      <span className="text-faint">
        · checked {status.checkedAt.toLocaleTimeString("en-US", { timeStyle: "short" })}
      </span>
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
  const inbox = itemsInView(payload, { kind: "inbox" }).length;
  return (
    <footer className="flex items-center gap-4 border-t border-line bg-surface px-5 py-2 text-xs text-muted">
      <span className="flex items-center gap-2">
        <HardDrive aria-hidden className="h-3.5 w-3.5" />
        {payload.items.length.toLocaleString()} PDFs stored · {fileSize(stored)} ·{" "}
        {inbox.toLocaleString()} in inbox
      </span>
      <BucketState read={read} />
    </footer>
  );
}
