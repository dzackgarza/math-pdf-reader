// Reader page: the prebuilt PDF.js viewer over the stored PDF, full width, under a bar with
// back and forward and a link to the current view. The page's address carries PDF.js's view
// parameters (`#page=…&zoom=…`, PDF.js's open parameters), so reloading or sharing it opens the
// same view. The Highwire `citation_*` tags let the Zotero Connector save the page.
import { html, raw } from "hono/html";
import type { BucketItem } from "./libraryContract";

export function pdfUrlPath(key: string): string {
  return `/pdf/${encodeURIComponent(key)}.pdf`;
}

export function readerUrlPath(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

// Lucide icons (lucide.dev, ISC): arrow-left, arrow-right, link, check.
const ICON = (paths: string) =>
  raw(
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
  );
const BACK = ICON('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>');
const FORWARD = ICON('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>');
const LINK = ICON(
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
);

// Runs in the reader page. The viewer is same-origin, so the page reads PDF.js's event bus:
// every view change (page, zoom, scroll) replaces the address's fragment with PDF.js's own
// open parameters, and the fragment the page was opened with goes to the viewer.
const SCRIPT = raw(`
const frame = document.querySelector("iframe");
frame.src = frame.dataset.viewer + location.hash;
const navigate = (event) => {
  if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); history.back(); }
  if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); history.forward(); }
};
document.addEventListener("keydown", navigate);
document.getElementById("back").addEventListener("click", () => history.back());
document.getElementById("forward").addEventListener("click", () => history.forward());
const copy = document.getElementById("copy-link");
copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  copy.dataset.copied = "";
  setTimeout(() => delete copy.dataset.copied, 1500);
});
frame.addEventListener("load", async () => {
  frame.contentWindow.addEventListener("keydown", navigate);
  const viewer = frame.contentWindow.PDFViewerApplication;
  await viewer.initializedPromise;
  viewer.eventBus.on("updateviewarea", ({ location: view }) => {
    history.replaceState(history.state, "", view.pdfOpenParams);
  });
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
      button {
        display: inline-flex; align-items: center; justify-content: center; flex: none;
        width: 2rem; height: 2rem; border: 0; border-radius: 0.375rem;
        background: none; color: var(--muted); cursor: pointer;
      }
      button:hover { background: var(--surface); color: var(--ink); }
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
      <button id="back" type="button" aria-label="Back" title="Back (Alt+←)">${BACK}</button>
      <button id="forward" type="button" aria-label="Forward" title="Forward (Alt+→)">${FORWARD}</button>
      <h1 title="${item.title}">${item.title}</h1>
      <button id="copy-link" type="button" aria-label="Copy link to this view" title="Copy link to this view">${LINK}</button>
    </header>
    <iframe data-viewer="${viewer}" title="${item.title}"></iframe>
    <script type="module">${SCRIPT}</script>
  </body>
</html>`;
}
