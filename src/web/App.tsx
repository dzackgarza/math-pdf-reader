// The library window: the first read of the library and of the saved layout, then the workspace.
// Later reads of the library never leave the workspace (useLibraryApi keeps the library shown).
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Redirect, useLocation } from "wouter";
import {
  defaultColumnLayout,
  readColumnLayout,
  readLibraryLayout,
  writeColumnLayout,
  writeLibraryLayout,
} from "./columnModel";
import { screenAt } from "./routes";
import { useBucketStatus } from "./useBucketStatus";
import { useLibraryApi } from "./useLibraryApi";
import Workspace from "./Workspace";

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center bg-surface p-6">{children}</div>;
}

export default function App() {
  const { state, reload, api } = useLibraryApi();
  const read = useBucketStatus();
  const [location] = useLocation();
  const [columnsRead, setColumnsRead] = useState(readColumnLayout);
  const [layoutRead, setLayoutRead] = useState(readLibraryLayout);
  const screen = useMemo(() => screenAt(location), [location]);

  if (state.status === "loading") {
    return (
      <FullScreen>
        <output className="flex items-center gap-3 text-base text-muted">
          <LoaderCircle aria-hidden className="h-5 w-5 animate-spin text-accent" /> Loading the
          library
        </output>
      </FullScreen>
    );
  }

  if (state.status === "failed") {
    return (
      <FullScreen>
        <section
          role="alert"
          className="w-full max-w-2xl rounded-xl bg-panel p-6 shadow-lg ring-1 ring-line"
        >
          <h1 className="flex items-center gap-2 text-lg font-semibold text-danger">
            <AlertTriangle aria-hidden className="h-5 w-5" /> The library could not be loaded
          </h1>
          <p className="mt-3 text-sm break-words whitespace-pre-wrap text-ink">{state.message}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            <RefreshCw className="h-4 w-4" /> Reload the library
          </button>
        </section>
      </FullScreen>
    );
  }

  if (columnsRead.status === "invalid" || layoutRead.status === "invalid") {
    const reasons = [columnsRead, layoutRead].flatMap((saved) =>
      saved.status === "invalid" ? [saved.reason] : [],
    );
    return (
      <FullScreen>
        <section
          role="alert"
          className="w-full max-w-xl rounded-xl bg-panel p-6 shadow-lg ring-1 ring-line"
        >
          <h1 className="text-lg font-semibold">The saved layout does not fit this version</h1>
          <pre className="mt-3 max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">
            {reasons.join("\n")}
          </pre>
          <button
            type="button"
            onClick={() => {
              writeColumnLayout(defaultColumnLayout());
              writeLibraryLayout("list");
              setColumnsRead(readColumnLayout());
              setLayoutRead(readLibraryLayout());
            }}
            className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Reset the layout
          </button>
        </section>
      </FullScreen>
    );
  }

  if (screen === null) {
    return <Redirect to="/" />;
  }
  return (
    <Workspace
      payload={state.payload}
      readFailure={state.readFailure}
      read={read}
      screen={screen}
      api={api}
      initialColumns={columnsRead.layout}
      initialLayout={layoutRead.layout}
    />
  );
}
