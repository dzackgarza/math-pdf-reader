import { Folder, FolderPlus, History, Library, Search, Settings, Shapes, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { QUICK_FILTERS } from "../librarySelectors";

function NavItem({
  to,
  icon,
  label,
  count,
  alsoAt = [],
}: {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number;
  // Further paths this entry is the current page for: the library under a quick filter.
  alsoAt?: string[];
}) {
  const [location] = useLocation();
  const active =
    location === to || alsoAt.includes(location) || (to !== "/" && location.startsWith(`${to}/`));
  return (
    <Link
      href={to}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm ${
        active ? "bg-accent-soft font-medium text-accent" : "text-ink hover:bg-black/[0.04]"
      }`}
    >
      <span className={`h-4 w-4 shrink-0 ${active ? "text-accent" : "text-muted"}`}>{icon}</span>
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span className="text-xs font-normal text-muted tabular-nums">
          {count.toLocaleString()}
        </span>
      )}
    </Link>
  );
}

export default function Sidebar({
  pdfCount,
  onNewCollection,
}: {
  pdfCount: number;
  onNewCollection: () => void;
}) {
  const icon = "h-4 w-4";
  return (
    <nav
      aria-label="Library"
      className="flex h-full w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface px-2 py-3"
    >
      <div className="space-y-0.5">
        <NavItem
          to="/"
          icon={<Library className={icon} />}
          label="Library"
          count={pdfCount}
          alsoAt={QUICK_FILTERS.map((filter) => filter.path)}
        />
        <NavItem to="/timeline" icon={<History className={icon} />} label="Timeline" />
      </div>

      <div className="space-y-0.5">
        <div className="group flex items-center">
          <div className="flex-1">
            <NavItem
              to="/organization/collections"
              icon={<Folder className={icon} />}
              label="Collections"
            />
          </div>
          <button
            type="button"
            aria-label="New collection"
            title="New collection"
            onClick={onNewCollection}
            className="rounded p-1 text-faint hover:bg-black/[0.04] hover:text-ink"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
        </div>
        <NavItem to="/organization/topics" icon={<Shapes className={icon} />} label="Topics" />
        <NavItem to="/organization/tags" icon={<Tag className={icon} />} label="Tags" />
        <NavItem
          to="/organization/saved"
          icon={<Search className={icon} />}
          label="Saved Searches"
        />
      </div>

      <div className="mt-auto">
        <NavItem to="/settings" icon={<Settings className={icon} />} label="Settings" />
      </div>
    </nav>
  );
}
