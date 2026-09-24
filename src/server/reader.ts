// Reader page: the prebuilt PDF.js viewer over the stored PDF, full width, under a bar with a
// Library button, back and forward, and a link to the current view. The page's address carries
// PDF.js's view parameters (`#page=…&zoom=…`, PDF.js's open parameters), so reloading or sharing
// it opens the same view. The Highwire `citation_*` tags let the Zotero Connector save the page.
import { html, raw } from "hono/html";
import { type BucketItem, LIBRARY_VIEW_KEY } from "./libraryContract";

export function pdfUrlPath(key: string): string {
  return `/pdf/${encodeURIComponent(key)}.pdf`;
}

export function readerUrlPath(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

// Lucide icons (lucide.dev, ISC): library-big, arrow-left, arrow-right, link.
const ICON = (paths: string) =>
  raw(
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
  );
const LIBRARY = ICON(
  '<rect width="8" height="18" x="3" y="3" rx="1"/><path d="M7 3v18"/><path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"/>',
);
const BACK = ICON('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>');
const FORWARD = ICON('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>');
const LINK = ICON(
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
);

// Runs before the viewer frame loads. PDF.js dispatches `webviewerloaded` on the embedding
// document before it initializes, for the embedder to set options. A viewer in a frame counts
// itself embedded and keeps no navigation history (PDFViewerApplication._initializeViewerComponents
// creates PDFHistory only when not embedded). The frame is this page's whole document, so the
// viewer is told it is not embedded, and external links keep leaving through the top window, as
// they do for an embedded viewer.
const BEFORE_VIEWER = raw(`
document.addEventListener("webviewerloaded", (event) => {
  const viewerWindow = event.detail.source;
  viewerWindow.PDFViewerApplication.isViewerEmbedded = false;
  const { LinkTarget } = viewerWindow.PDFViewerApplicationConstants;
  viewerWindow.PDFViewerApplicationOptions.set("externalLinkTarget", LinkTarget.TOP);
});
`);

// Runs in the reader page. The viewer is same-origin, so the page reads PDF.js's event bus.
// Back and forward are PDF.js's PDFHistory: the positions left by following links, outline
// entries and page jumps in this PDF. PDFHistory.back and forward do nothing at either end, so
// they never leave the document. Every view change (page, zoom, scroll) replaces the address's
// fragment with PDF.js's own open parameters. The fragment the page was opened with goes to the
// viewer as a same-document replace, which PDF.js's hashchange handler applies (as the initial
// view if the document is still loading) and which adds no history entry.
const SCRIPT = raw(`
const frame = document.querySelector("iframe");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const libraryView = sessionStorage.getItem(${JSON.stringify(LIBRARY_VIEW_KEY)});
if (libraryView !== null) {
  document.getElementById("library").href = "/" + libraryView;
}
const copy = document.getElementById("copy-link");
copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  copy.dataset.copied = "";
  setTimeout(() => delete copy.dataset.copied, 1500);
});
frame.addEventListener("load", async () => {
  const inner = frame.contentWindow.location;
  if (location.hash !== "" && inner.hash !== location.hash) {
    inner.replace(inner.pathname + inner.search + location.hash);
  }
  const viewer = frame.contentWindow.PDFViewerApplication;
  await viewer.initializedPromise;
  const history = viewer.pdfHistory;
  // PDFHistory's own bounds: the frame's history state carries the position's uid, and
  // _maxUid is the newest position recorded.
  const showBounds = () => {
    const uid = frame.contentWindow.history.state?.uid;
    backButton.disabled = !(uid > 0);
    forwardButton.disabled = !(uid < history._maxUid);
  };
  const navigate = (event) => {
    if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); history.back(); }
    if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); history.forward(); }
  };
  document.addEventListener("keydown", navigate);
  frame.contentWindow.addEventListener("keydown", navigate);
  backButton.addEventListener("click", () => history.back());
  forwardButton.addEventListener("click", () => history.forward());
  viewer.eventBus.on("updateviewarea", ({ location: view }) => {
    window.history.replaceState(window.history.state, "", view.pdfOpenParams);
    showBounds();
  });
  frame.contentWindow.addEventListener("popstate", showBounds);
});
`);

export function readerPage(item: BucketItem, origin: string) {
  const { provenance } = item;
  const viewer = `/pdfjs/web/viewer.html?file=${encodeURIComponent(pdfUrlPath(item.id))}`;
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${item.title}</title>
    <meta name="citation_title" content="${item.title}" />
    <meta name="citation_pdf_url" content="${origin}${pdfUrlPath(item.id)}" />
    <meta name="citation_abstract_html_url" content="${provenance.source_url}" />
    <script>${BEFORE_VIEWER}</script>
    <style>
      :root {
        --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --surface: #f8f9fb; --accent: #2563eb;
        font-family: Inter, "Segoe UI", system-ui, sans-serif; color: var(--ink);
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; height: 100%; }
      body { display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--surface); }
      header {
        display: flex; align-items: center; gap: 0.25rem; min-width: 0;
        padding: 0.25rem 0.5rem; background: #fff; border-bottom: 1px solid var(--line);
      }
      button, #library {
        display: inline-flex; align-items: center; justify-content: center; flex: none;
        height: 2rem; border: 0; border-radius: 0.375rem;
        background: none; color: var(--muted); cursor: pointer;
      }
      button { width: 2rem; }
      #library {
        gap: 0.375rem; padding: 0 0.625rem 0 0.5rem; margin-right: 0.25rem;
        font-size: 0.8125rem; font-weight: 500; text-decoration: none;
        border-right: 1px solid var(--line); border-radius: 0.375rem 0 0 0.375rem;
      }
      button:hover:enabled, #library:hover { background: var(--surface); color: var(--ink); }
      button:disabled { opacity: 0.35; cursor: default; }
      #copy-link[data-copied] { color: var(--accent); }
      h1 {
        flex: 1; min-width: 0; margin: 0 0.5rem; overflow: hidden;
        font-size: 0.875rem; font-weight: 600; white-space: nowrap; text-overflow: ellipsis;
      }
      iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    </style>
  </head>
  <body>
    <header>
      <a id="library" href="/" aria-label="Library" title="Library">${LIBRARY}<span>Library</span></a>
      <button id="back" type="button" aria-label="Back" title="Back (Alt+←)" disabled>${BACK}</button>
      <button id="forward" type="button" aria-label="Forward" title="Forward (Alt+→)" disabled>${FORWARD}</button>
      <h1 title="${item.title}">${item.title}</h1>
      <button id="copy-link" type="button" aria-label="Copy link to this view" title="Copy link to this view">${LINK}</button>
    </header>
    <iframe src="${viewer}" title="${item.title}"></iframe>
    <script type="module">${SCRIPT}</script>
  </body>
</html>`;
}
