import { FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { type Preferences, THEMES, type Theme, ThemeSchema } from "../../contract/library";
import Switch from "../components/Switch";
import { showInFolder } from "../desktop";
import type { StatusRead } from "../useBucketStatus";

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

export default function SettingsScreen({
  read,
  onError,
  preferences,
  onPreferences,
}: {
  read: StatusRead;
  onError: (message: string) => void;
  preferences: Preferences;
  onPreferences: (preferences: Preferences) => void;
}) {
  if (read.kind !== "read") {
    return null;
  }
  const { settings, service } = read.status;
  const reveal = showInFolder();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <dl className="max-w-2xl text-sm">
        <Row label="Library folder">
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
        </Row>
        <Row label="Reader">
          <Switch
            label="Open the outline when a PDF opens"
            on={preferences.outlineOnOpen}
            onChange={(outlineOnOpen) => onPreferences({ ...preferences, outlineOnOpen })}
          />
          <span>Open the outline when a PDF opens</span>
        </Row>
        <Row label="Theme">
          <select
            aria-label="Theme"
            value={preferences.theme}
            onChange={(event) =>
              onPreferences({ ...preferences, theme: ThemeSchema.parse(event.target.value) })
            }
            className="rounded-md border border-line bg-panel px-2 py-1 text-ink"
          >
            {THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {THEME_LABELS[theme]}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Version">{service.version}</Row>
      </dl>
    </div>
  );
}
