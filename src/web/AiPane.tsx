// The assistant pane: the right sidebar of a PDF tab, which shows the PDF's chat, OpenCode's own
// web UI, in a frame (server/src/ai.rs). It collapses to a slim rail and resizes by its left
// edge; both are remembered. The frame loads two addresses in turn: the first signs it in to the
// private OpenCode server, the second is the PDF's chat. The server starts at the first request
// of an expanded pane, so a collapsed pane costs nothing.
import {
  AlertTriangle,
  FileText,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AiSessionRequestSchema, AiSessionSchema } from "../contract/ai";
import ExtractionRunner from "./components/ExtractionRunner";
import type { ReaderExtraction } from "./readerTabs";
import { request } from "./useLibraryApi";

const STORAGE_KEY = "pdf-bucket.ai-pane";
const MIN_WIDTH = 320;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 420;

const SavedPaneSchema = z.strictObject({
  collapsed: z.boolean(),
  width: z.number().int().min(MIN_WIDTH).max(MAX_WIDTH),
});
type SavedPane = z.infer<typeof SavedPaneSchema>;

function readPane(): SavedPane {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null
    ? { collapsed: true, width: DEFAULT_WIDTH }
    : SavedPaneSchema.parse(JSON.parse(raw));
}

// The pane's remembered state, written at every change.
export function useAiPane() {
  const [pane, setPane] = useState(readPane);
  const change = useCallback((next: Partial<SavedPane>) => {
    setPane((current) => {
      const saved = { ...current, ...next };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      return saved;
    });
  }, []);
  return { pane, change };
}

type Session =
  | { status: "loading" }
  | { status: "failed"; message: string }
  // The frame shows ADDRESS; the chat's address follows the sign-in's.
  | { status: "ready"; address: string; chat: string };

type PaneProps = {
  // The PDF whose chat the pane shows.
  itemKey: string;
  pane: SavedPane;
  onChange: (next: Partial<SavedPane>) => void;
  // The PDF's extraction and the means to run one; null while the library has not given them.
  extraction: ReturnType<ReaderExtraction>;
};

function Chat({ itemKey }: { itemKey: string }) {
  const [session, setSession] = useState<Session>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The attempt is part of what the effect depends on, so a retry asks again.
  useEffect(() => {
    let current = true;
    setSession({ status: "loading" });
    request(AiSessionSchema, "POST", "/api/ai/session", AiSessionRequestSchema.parse({ key: itemKey }))
      .then(
        ({ pairUrl, sessionUrl }) =>
          current && setSession({ status: "ready", address: pairUrl, chat: sessionUrl }),
      )
      .catch(
        (error: Error) => current && setSession({ status: "failed", message: error.message }),
      );
    return () => {
      current = false;
    };
  }, [itemKey, attempt]);

  if (session.status === "loading") {
    return (
      <output className="flex items-center gap-2 p-4 text-sm text-muted">
        <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" /> Starting the assistant
      </output>
    );
  }
  if (session.status === "failed") {
    return (
      <div role="alert" className="p-4 text-sm">
        <p className="flex items-center gap-2 font-medium text-danger">
          <AlertTriangle aria-hidden className="h-4 w-4" /> The assistant is not available
        </p>
        <p className="mt-2 break-words whitespace-pre-wrap text-muted">{session.message}</p>
        <button
          type="button"
          onClick={() => setAttempt((count) => count + 1)}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 hover:bg-surface"
        >
          <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Try again
        </button>
      </div>
    );
  }
  return (
    <iframe
      title="Assistant"
      src={session.address}
      // The sign-in answers by redirecting to OpenCode's home; the chat follows its load.
      onLoad={() =>
        setSession((current) =>
          current.status === "ready" && current.address !== current.chat
            ? { ...current, address: current.chat }
            : current,
        )
      }
      className="h-full w-full border-0 bg-panel"
    />
  );
}

// Whether the assistant reads an extraction of this PDF, and the control to make one.
function ExtractionStrip({ extraction }: { extraction: NonNullable<PaneProps["extraction"]> }) {
  const { state, attempt } = extraction;
  const running = attempt?.kind === "running";
  return (
    <section aria-label="Extraction" className="shrink-0 space-y-2 border-b border-line px-3 py-2">
      <p className="flex items-center gap-2 text-xs text-muted">
        {running ? (
          <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <FileText aria-hidden className="h-3.5 w-3.5" />
        )}
        {running
          ? "Extracting… the assistant reads the PDF's own text until it finishes"
          : state.status === "extracted"
            ? "Extracted: the assistant reads the extraction"
            : "No extraction: the assistant reads the PDF's own text"}
      </p>
      <ExtractionRunner {...extraction} />
    </section>
  );
}

export function AiPane({ itemKey, pane, onChange, extraction }: PaneProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  if (pane.collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center border-l border-line bg-panel pt-2">
        <button
          type="button"
          aria-label="Open the assistant"
          title="Open the assistant"
          onClick={() => onChange({ collapsed: false })}
          className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-ink/[0.08] hover:text-ink"
        >
          <MessageSquare aria-hidden className="h-4 w-4" />
        </button>
        {extraction !== null && (
          <span
            role="status"
            title={
              extraction.attempt?.kind === "running"
                ? "Extracting"
                : extraction.state.status === "extracted"
                  ? "Extracted"
                  : "No extraction"
            }
            className="mt-2 flex h-6 w-6 items-center justify-center text-muted"
          >
            {extraction.attempt?.kind === "running" ? (
              <LoaderCircle aria-hidden className="h-4 w-4 animate-spin text-accent" />
            ) : (
              <FileText
                aria-hidden
                className={`h-4 w-4 ${extraction.state.status === "extracted" ? "text-filed" : "text-faint"}`}
              />
            )}
          </span>
        )}
      </aside>
    );
  }
  return (
    <aside
      aria-label="Assistant"
      style={{ width: pane.width }}
      className="relative flex shrink-0 flex-col border-l border-line bg-panel"
    >
      {/* The left edge resizes the pane; the frame ignores the pointer meanwhile, or it would
          take the drag. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the assistant"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          start.current = { x: event.clientX, width: pane.width };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (dragging) {
            const width = start.current.width + start.current.x - event.clientX;
            onChange({ width: Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))) });
          }
        }}
        onPointerUp={() => setDragging(false)}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/30"
      />
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line pr-1.5 pl-3 text-[0.8125rem] font-medium">
        Assistant
        <button
          type="button"
          aria-label="Collapse the assistant"
          title="Collapse the assistant"
          onClick={() => onChange({ collapsed: true })}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/[0.08] hover:text-ink"
        >
          <PanelRightClose aria-hidden className="h-4 w-4" />
        </button>
      </header>
      {extraction !== null && <ExtractionStrip extraction={extraction} />}
      <div className={`min-h-0 flex-1 ${dragging ? "pointer-events-none" : ""}`}>
        <Chat key={itemKey} itemKey={itemKey} />
      </div>
    </aside>
  );
}
