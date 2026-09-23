import {
  CircleCheck,
  CircleX,
  CloudDownload,
  Folder,
  Inbox,
  Library,
  Search,
  Settings,
  Shapes,
  Tag,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import type { LibraryPayload } from "../../server/libraryContract";
import { isTopic } from "../format";
import { itemsInView, tagCounts } from "../librarySelectors";
import type { StatusRead } from "../useBucketStatus";

function NavItem({
  to,
  icon,
  label,
  count,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  const [location] = useLocation();
  const active = location === to || (to !== "/" && location.startsWith(`${to}/`));
  return (
    <Link
      href={to}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
        active ? "bg-accent-soft font-semibold text-accent" : "text-ink hover:bg-black/[0.04]"
      }`}
    >
      <span className={`h-4.5 w-4.5 shrink-0 ${active ? "text-accent" : "text-muted"}`}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span className="text-xs text-muted tabular-nums">{count.toLocaleString()}</span>
      )}
    </Link>
  );
}

function CaptureStatus({ read }: { read: StatusRead }) {
  if (read.kind === "checking") {
    return <p className="px-3 text-xs text-muted">Checking the capture endpoint…</p>;
  }
  if (read.kind === "failed") {
    return (
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-3 text-xs text-red-700">
        The bucket status could not be read: {read.message}
      </p>
    );
  }
  const { status } = read;
  const ready = status.capabilities.capture;
  return (
    <div className={`rounded-lg px-3 py-3 text-xs ${ready ? "bg-filed-soft" : "bg-red-50"}`}>
      <p
        className={`flex items-center gap-1.5 text-sm font-semibold ${ready ? "text-filed" : "text-red-700"}`}
      >
        {ready ? <CircleCheck className="h-4 w-4" /> : <CircleX className="h-4 w-4" />}
        {ready ? "Capture endpoint ready" : "Capture endpoint unavailable"}
      </p>
      <p className="mt-1 leading-relaxed text-muted">
        {ready
          ? "PDFs the Chrome and Firefox extensions intercept are stored here. Switch capture per browser in each extension's options."
          : `The bucket cannot write to ${status.root}.`}
      </p>
    </div>
  );
}

export default function Sidebar({ payload, read }: { payload: LibraryPayload; read: StatusRead }) {
  const tags = tagCounts(payload.items);
  const icon = "h-4.5 w-4.5";
  return (
    <nav
      aria-label="Library"
      className="flex h-full w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r border-line bg-surface px-3 py-5"
    >
      <div className="flex items-center gap-3 px-2">
        <img src="/favicon.svg" alt="" className="h-9 w-9" />
        <span>
          <span className="block text-base leading-tight font-bold">PDF Bucket</span>
          <span className="block text-xs text-muted">Capture · Preserve · Read</span>
        </span>
      </div>

      <div className="space-y-0.5">
        <NavItem
          to="/"
          icon={<Library className={icon} />}
          label="Library"
          count={payload.items.length}
        />
        <NavItem
          to="/inbox"
          icon={<Inbox className={icon} />}
          label="Inbox"
          count={itemsInView(payload, { kind: "inbox" }).length}
        />
        <NavItem
          to="/cache"
          icon={<CloudDownload className={icon} />}
          label="Offline Cache"
          count={payload.items.length}
        />
      </div>

      <div className="space-y-0.5">
        <h2 className="px-3 pb-1 text-xs font-semibold text-muted">Organization</h2>
        <NavItem
          to="/organization/collections"
          icon={<Folder className={icon} />}
          label="Collections"
          count={payload.collections.length}
        />
        <NavItem
          to="/organization/topics"
          icon={<Shapes className={icon} />}
          label="Topics"
          count={tags.filter(([tag]) => isTopic(tag)).length}
        />
        <NavItem
          to="/organization/tags"
          icon={<Tag className={icon} />}
          label="Tags"
          count={tags.filter(([tag]) => !isTopic(tag)).length}
        />
        <NavItem
          to="/organization/saved"
          icon={<Search className={icon} />}
          label="Saved Searches"
          count={payload.savedSearches.length}
        />
      </div>

      <div className="space-y-2">
        <h2 className="px-3 text-xs font-semibold text-muted">Browser Capture</h2>
        <CaptureStatus read={read} />
      </div>

      <div className="mt-auto space-y-0.5">
        <NavItem to="/settings" icon={<Settings className={icon} />} label="Settings" />
        {read.kind === "read" && (
          <p className="px-3 pt-2 text-xs text-faint">PDF Bucket v{read.status.service.version}</p>
        )}
      </div>
    </nav>
  );
}
