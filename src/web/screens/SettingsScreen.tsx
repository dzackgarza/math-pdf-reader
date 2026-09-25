import { FolderOpen, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import {
  type Preferences,
  type Settings,
  THEMES,
  type Theme,
  ThemeSchema,
} from "../../contract/library";
import Switch from "../components/Switch";
import { showInFolder } from "../desktop";
import type { BucketStatus, StatusRead } from "../useBucketStatus";

const THEME_LABELS: Record<Theme, string> = {
  system: "Match the system",
  light: "Light",
  dark: "Dark",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line py-3">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">{children}</dd>
    </div>
  );
}

function LibraryFolder({
  settings,
  onError,
}: {
  settings: Settings;
  onError: (message: string) => void;
}) {
  const reveal = showInFolder();
  return (
    <>
      <span className="min-w-0 truncate font-mono text-xs" title={settings.root}>
        {settings.root}
      </span>
      {reveal !== null && (
        <button
          type="button"
          aria-label="Show in folder"
          title="Show in folder"
          onClick={() => {
            reveal(settings.root).then(
              () => undefined,
              (error: Error) => onError(error.message),
            );
          }}
          className="rounded p-1 text-muted hover:bg-surface hover:text-ink"
        >
          <FolderOpen className="h-4 w-4" />
        </button>
      )}
    </>
  );
}

// What the bucket's /status report says for one row: the value once read, a spinner while it is
// being read, and why it could not be read.
function Reported({
  read,
  value,
}: {
  read: StatusRead;
  value: (status: BucketStatus) => ReactNode;
}) {
  switch (read.kind) {
    case "checking":
      return <LoaderCircle aria-label="Checking" className="h-4 w-4 animate-spin text-muted" />;
    case "failed":
      return (
        <span role="alert" className="text-danger">
          The bucket's status could not be read: {read.message}
        </span>
      );
    case "read":
      return value(read.status);
  }
}

export default function SettingsScreen({
  read,
  onError,
  preferences,
  onPreferences,
}: {
  read: StatusRead;
  onError: (message: string) => void;
  preferences: Preferences;
  // Changes the preferences it names; the others stay as the bucket holds them.
  onPreferences: (update: Partial<Preferences>) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <dl className="max-w-2xl text-sm">
        <Row label="Library folder">
          <Reported
            read={read}
            value={(status) => <LibraryFolder settings={status.settings} onError={onError} />}
          />
        </Row>
        <Row label="Reader">
          <Switch
            label="Open the outline when a PDF opens"
            on={preferences.outlineOnOpen}
            onChange={(outlineOnOpen) => onPreferences({ outlineOnOpen })}
          />
          <span>Open the outline when a PDF opens</span>
        </Row>
        <Row label="Theme">
          <select
            aria-label="Theme"
            value={preferences.theme}
            onChange={(event) => onPreferences({ theme: ThemeSchema.parse(event.target.value) })}
            className="rounded-md border border-line bg-panel px-2 py-1 text-ink"
          >
            {THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {THEME_LABELS[theme]}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Version">
          <Reported read={read} value={(status) => status.service.version} />
        </Row>
      </dl>
    </div>
  );
}
