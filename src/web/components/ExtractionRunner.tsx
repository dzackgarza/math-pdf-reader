// The inspector's control for running an extraction plugin on the item, and the outcome of
// its last run: the placed files, the plugin's exit code and stderr, or the violated limits.
import { AlertTriangle, CheckCircle2, LoaderCircle, Play } from "lucide-react";
import prettyBytes from "pretty-bytes";
import { useState } from "react";
import type { ExtractionPlugin, PdfLimit } from "../../server/extractionContract";
import type { ExtractionAttempt } from "../libraryActions";
import type { PluginsState } from "../useExtractionPlugins";

export type ItemExtractionActions = {
  plugins: PluginsState;
  attempt: ExtractionAttempt | undefined;
  onRun: (pluginId: string) => void;
};

function pluginName(plugins: ExtractionPlugin[], id: string): string {
  const plugin = plugins.find((candidate) => candidate.id === id);
  return plugin === undefined ? id : plugin.name;
}

function limitText(limit: PdfLimit, observed: number): string {
  return limit.kind === "max_pages"
    ? `this PDF has ${observed} pages; the plugin accepts at most ${limit.value}`
    : `this PDF is ${prettyBytes(observed)}; the plugin accepts at most ${prettyBytes(limit.value)}`;
}

function Outcome({
  attempt,
  plugins,
}: {
  attempt: ExtractionAttempt;
  plugins: ExtractionPlugin[];
}) {
  if (attempt.kind === "running") {
    return (
      <p role="status" className="text-sm text-muted">
        {pluginName(plugins, attempt.pluginId)} is working on this PDF; nothing is placed until it
        finishes.
      </p>
    );
  }
  if (attempt.kind === "error") {
    return (
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
        {attempt.message}
      </p>
    );
  }
  const { outcome } = attempt;
  const name = pluginName(plugins, outcome.plugin_id);
  if (outcome.status === "succeeded") {
    const files = outcome.artifacts.length + 1;
    return (
      <p className="flex items-center gap-2 rounded-lg bg-filed-soft px-3 py-2 text-sm text-filed">
        <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
        {name} wrote {files} {files === 1 ? "file" : "files"}
      </p>
    );
  }
  if (outcome.status === "rejected") {
    return (
      <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" /> {name} did not run
        </p>
        <ul className="mt-1 list-disc pl-6">
          {outcome.violations.map((violation) => (
            <li key={violation.limit.kind}>{limitText(violation.limit, violation.observed)}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" /> {name} exited with code{" "}
        {outcome.exit_code}; nothing was written
      </p>
      <pre className="mt-2 max-h-48 overflow-auto rounded bg-white/70 p-2 font-mono text-xs whitespace-pre-wrap">
        {outcome.stderr.trim() === "" ? "(no stderr)" : outcome.stderr}
      </pre>
    </div>
  );
}

function RunControls({
  plugins,
  attempt,
  onRun,
}: {
  plugins: ExtractionPlugin[];
  attempt: ExtractionAttempt | undefined;
  onRun: (pluginId: string) => void;
}) {
  const [chosen, setChosen] = useState(plugins.length > 0 ? plugins[0].id : "");
  const running = attempt?.kind === "running" ? attempt : undefined;
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Extraction plugin"
        value={chosen}
        disabled={running !== undefined}
        onChange={(event) => setChosen(event.target.value)}
        title={plugins.find((plugin) => plugin.id === chosen)?.accepted_inputs[0]?.label}
        className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1.5 text-sm"
      >
        {plugins.map((plugin) => (
          <option key={plugin.id} value={plugin.id}>
            {plugin.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={running !== undefined || chosen === ""}
        onClick={() => onRun(chosen)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-60"
      >
        {running === undefined ? (
          <>
            <Play className="h-3.5 w-3.5" /> Run
          </>
        ) : (
          <>
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin text-accent" /> Running…
          </>
        )}
      </button>
    </div>
  );
}

export default function ExtractionRunner({ plugins, attempt, onRun }: ItemExtractionActions) {
  if (plugins.status === "loading") {
    return <p className="text-sm text-muted">Loading extraction plugins…</p>;
  }
  if (plugins.status === "failed") {
    return (
      <p role="alert" className="text-sm text-red-700">
        Extraction plugins could not be listed: {plugins.message}
      </p>
    );
  }
  return (
    <div className="w-full space-y-2">
      <RunControls plugins={plugins.plugins} attempt={attempt} onRun={onRun} />
      {attempt !== undefined && <Outcome attempt={attempt} plugins={plugins.plugins} />}
    </div>
  );
}
