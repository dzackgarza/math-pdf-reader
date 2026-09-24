// Reader page: the prebuilt PDF.js viewer over the stored PDF, full width, under a bar with a
// Library button, back and forward, and a link to the current view. The page's address carries
// PDF.js's view parameters (`#page=…&zoom=…`, PDF.js's open parameters), so reloading or sharing
// it opens the same view. Annotations made with PDF.js's editors are saved into the stored PDF.
// The Highwire `citation_*` tags let the Zotero Connector save the page.
import { html, raw } from "hono/html";
import {
  type BucketItem,
  LIBRARY_VIEW_KEY,
  MIN_PAGE_SECONDS,
  type Preferences,
  type Theme,
} from "./libraryContract";

export function pdfUrlPath(key: string): string {
  return `/pdf/${encodeURIComponent(key)}.pdf`;
}

export function readerUrlPath(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

function itemApiPath(key: string): string {
  return `/api/items/${encodeURIComponent(key)}`;
}

// The view the reader opens at when its address names none: the page last viewed.
function resumeHash(item: BucketItem): string {
  return item.reading.status === "viewed" ? `#page=${item.reading.page}` : "";
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
// they do for an embedded viewer. PDF.js's comment tool, off by default, is turned on beside
// its highlight, text, ink and image tools. The viewer takes the theme preference
// (viewerCssTheme). The sidebar opens as the preferences say, never as the PDF's /PageMode
// asks (sidebarViewOnLoad set to a view overrides the page mode and PDF.js's remembered
// sidebar). The viewer's event bus exists once its
// initializedPromise settles, which happens before it opens the PDF, so a listener added then
// cannot miss \`documentloaded\`. PDF.js refuses to unload while the document holds any
// annotation (onBeforeUnload with _hasChanges), since it expects a download to keep them; here
// they are saved, so a listener registered ahead of PDF.js's stops that refusal while every
// change is saved.
const BEFORE_VIEWER = raw(`
let annotationsSaved = true;
let documentLoaded;
const viewerDocumentLoaded = new Promise((resolve) => { documentLoaded = resolve; });
document.addEventListener("webviewerloaded", (event) => {
  const viewerWindow = event.detail.source;
  const app = viewerWindow.PDFViewerApplication;
  viewerWindow.addEventListener("beforeunload", (unload) => {
    if (annotationsSaved) {
      unload.stopImmediatePropagation();
    }
  });
  app.isViewerEmbedded = false;
  const { LinkTarget } = viewerWindow.PDFViewerApplicationConstants;
  const options = viewerWindow.PDFViewerApplicationOptions;
  options.set("externalLinkTarget", LinkTarget.TOP);
  options.set("enableComment", true);
  options.set("sidebarViewOnLoad", Number(document.documentElement.dataset.sidebarViewOnLoad));
  options.set("viewerCssTheme", Number(document.documentElement.dataset.viewerCssTheme));
  app.initializedPromise.then(() => app.eventBus.on("documentloaded", documentLoaded, { once: true }));
});
`);

// Runs in the reader page. The viewer is same-origin, so the page reads PDF.js's event bus.
// Back and forward are PDF.js's PDFHistory: the positions left by following links, outline
// entries and page jumps in this PDF. PDFHistory.back and forward do nothing at either end, so
// they never leave the document. Every view change (page, zoom, scroll) replaces the address's
// fragment with PDF.js's own open parameters. The fragment the page was opened with goes to the
// viewer as a same-document replace, which PDF.js's hashchange handler applies (as the initial
// view if the document is still loading) and which adds no history entry. An address without
// a fragment opens at the page last viewed.
//
// Reading: a second after the page changes, the page and the page count go to
// /api/items/<key>/reading, which records them as the item's last viewed page.
//
// Minutes without input after which the reader stops counting time as reading.
const IDLE_MINUTES = 10;

// Reading session: a stretch on one page counts once it lasts MIN_PAGE_SECONDS; it ends when
// the page changes, when the page is hidden, or IDLE_MINUTES after the last input (pointer,
// wheel, key), and a new one starts with the next input. The session (opening time, last
// moment read, seconds per page) goes to /api/reading-sessions every 30 seconds, on each page
// change, and as a beacon when the page is left; nothing is sent until a page is read.
//
// Saving: the annotation storage reports its first change after each save (onSetModified,
// wrapped so PDF.js's own callback still runs); a short pause later, PDFDocumentProxy.saveDocument
// writes the PDF with every annotation as an incremental update of the loaded file, and the page
// PUTs it to the server, which keeps it only while it carries the item's provenance. Saves run
// one after another; the Library link waits for a pending save.
const SCRIPT = raw(`
const frame = document.querySelector("iframe");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const libraryView = sessionStorage.getItem(${JSON.stringify(LIBRARY_VIEW_KEY)});
if (libraryView !== null) {
  document.getElementById("library").href = "/" + libraryView;
}
const saveStatus = document.getElementById("save-status");
const itemPath = document.body.dataset.itemPath;
const openAt = location.hash === "" ? document.body.dataset.resumeHash : location.hash;
const copy = document.getElementById("copy-link");
copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  copy.dataset.copied = "";
  setTimeout(() => delete copy.dataset.copied, 1500);
});
frame.addEventListener("load", async () => {
  const inner = frame.contentWindow.location;
  if (openAt !== "" && inner.hash !== openAt) {
    inner.replace(inner.pathname + inner.search + openAt);
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
  let recordedPage = null;
  let pendingRecord = null;
  const recordReading = () => {
    const reading = { page: viewer.page, pages: viewer.pagesCount };
    if (reading.page === recordedPage) {
      return;
    }
    recordedPage = reading.page;
    fetch(itemPath + "/reading", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reading),
    }).then(async (response) => {
      if (!response.ok) {
        saveStatus.textContent = "Page not recorded: " + (await response.json()).error.message;
        saveStatus.dataset.failed = "";
      }
    });
  };
  viewer.eventBus.on("updateviewarea", ({ location: view }) => {
    window.history.replaceState(window.history.state, "", view.pdfOpenParams);
    showBounds();
    clearTimeout(pendingRecord);
    pendingRecord = setTimeout(recordReading, 1000);
  });
  frame.contentWindow.addEventListener("popstate", showBounds);

  let pendingSave = null;
  let saves = Promise.resolve();
  const save = async () => {
    saveStatus.textContent = "Saving…";
    const bytes = await viewer.pdfDocument.saveDocument();
    const response = await fetch(itemPath + "/pdf", {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: bytes,
    });
    if (response.ok) {
      saveStatus.textContent = "";
      delete saveStatus.dataset.failed;
      annotationsSaved = pendingSave === null;
      return;
    }
    saveStatus.textContent = "Not saved: " + (await response.json()).error.message;
    saveStatus.dataset.failed = "";
  };
  const startSave = () => {
    pendingSave = null;
    saves = saves.then(save);
  };
  viewerDocumentLoaded.then(() => {
    const storage = viewer.pdfDocument.annotationStorage;
    const ownCallback = storage.onSetModified;
    storage.onSetModified = () => {
      ownCallback?.();
      annotationsSaved = false;
      clearTimeout(pendingSave);
      pendingSave = setTimeout(startSave, 700);
    };
  });
  const IDLE_MS = ${IDLE_MINUTES} * 60 * 1000;
  const MIN_PAGE_MS = ${MIN_PAGE_SECONDS} * 1000;
  const session = { id: crypto.randomUUID(), key: document.body.dataset.key, openedAt: new Date().toISOString() };
  const readMs = new Map();
  let stretch = null;
  let lastInput = Date.now();
  let lastRead = null;
  const readingUntil = () => Math.min(Date.now(), lastInput + IDLE_MS);
  const stretchMs = () => (stretch === null ? 0 : readingUntil() - stretch.since);
  const endStretch = () => {
    if (stretch !== null && stretchMs() >= MIN_PAGE_MS) {
      readMs.set(stretch.page, (readMs.get(stretch.page) ?? 0) + stretchMs());
      lastRead = readingUntil();
    }
    stretch = null;
  };
  const startStretch = (page) => {
    stretch = document.visibilityState === "visible" ? { page, since: Date.now() } : null;
  };
  const sessionReport = () => {
    const pages = new Map(readMs);
    let until = lastRead;
    if (stretch !== null && stretchMs() >= MIN_PAGE_MS) {
      pages.set(stretch.page, (pages.get(stretch.page) ?? 0) + stretchMs());
      until = readingUntil();
    }
    if (pages.size === 0) {
      return null;
    }
    const read = [...pages].map(([page, ms]) => ({ page, seconds: Math.round(ms / 1000) }));
    return JSON.stringify({ ...session, lastSeenAt: new Date(until).toISOString(), pages: read });
  };
  const sendSession = (asBeacon) => {
    const body = sessionReport();
    if (body === null) {
      return Promise.resolve();
    }
    if (asBeacon) {
      navigator.sendBeacon("/api/reading-sessions", new Blob([body], { type: "application/json" }));
      return Promise.resolve();
    }
    return fetch("/api/reading-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).then(async (response) => {
      if (!response.ok) {
        saveStatus.textContent = "Reading not recorded: " + (await response.json()).error.message;
        saveStatus.dataset.failed = "";
      }
    });
  };
  const onInput = () => {
    if (Date.now() - lastInput > IDLE_MS) {
      endStretch();
      lastInput = Date.now();
      startStretch(viewer.page);
      return;
    }
    lastInput = Date.now();
  };
  for (const target of [window, frame.contentWindow]) {
    for (const type of ["pointermove", "pointerdown", "wheel", "keydown"]) {
      target.addEventListener(type, onInput, { passive: true });
    }
  }
  viewerDocumentLoaded.then(() => startStretch(viewer.page));
  viewer.eventBus.on("pagechanging", ({ pageNumber }) => {
    endStretch();
    startStretch(pageNumber);
    sendSession(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      endStretch();
      sendSession(true);
    } else {
      startStretch(viewer.page);
    }
  });
  setInterval(() => sendSession(false), 30000);
  window.addEventListener("pagehide", () => sendSession(true));

  document.getElementById("library").addEventListener("click", async (event) => {
    event.preventDefault();
    await sendSession(false);
    if (pendingSave !== null) {
      clearTimeout(pendingSave);
      startSave();
    }
    await saves;
    location.assign(event.currentTarget.href);
  });
});
`);

// PDF.js's SidebarView values (web/ui_utils.js): NONE, OUTLINE.
const SIDEBAR_NONE = 0;
const SIDEBAR_OUTLINE = 2;

// PDF.js's viewerCssTheme values (web/app_options.js): automatic, light, dark.
const VIEWER_CSS_THEME: Record<Theme, number> = { system: 0, light: 1, dark: 2 };

export function readerPage(item: BucketItem, origin: string, preferences: Preferences) {
  const sidebarView = preferences.outlineOnOpen ? SIDEBAR_OUTLINE : SIDEBAR_NONE;
  const { provenance } = item;
  const viewer = `/pdfjs/web/viewer.html?file=${encodeURIComponent(pdfUrlPath(item.id))}`;
  return html`<!doctype html>
<html
  lang="en"
  data-theme="${preferences.theme}"
  data-sidebar-view-on-load="${sidebarView}"
  data-viewer-css-theme="${VIEWER_CSS_THEME[preferences.theme]}"
>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${item.title}</title>
    <meta name="citation_title" content="${item.title}" />
    ${item.authors.map((author) => html`<meta name="citation_author" content="${author}" />`)}
    <meta name="citation_pdf_url" content="${origin}${pdfUrlPath(item.id)}" />
    <meta name="citation_abstract_html_url" content="${provenance.source_url}" />
    <script>${BEFORE_VIEWER}</script>
    <style>
      /* The page's colour scheme is the theme preference's; light-dark() picks each colour. */
      :root {
        color-scheme: light dark;
        --ink: light-dark(#111827, #e4e7ec); --muted: light-dark(#6b7280, #98a2b3);
        --line: light-dark(#e5e7eb, #2c3441); --surface: light-dark(#f8f9fb, #0f141b);
        --panel: light-dark(#ffffff, #171d26); --accent: light-dark(#2563eb, #3b82f6);
        --danger: light-dark(#b91c1c, #f87171);
        font-family: Inter, "Segoe UI", system-ui, sans-serif; color: var(--ink);
      }
      :root[data-theme="light"] { color-scheme: light; }
      :root[data-theme="dark"] { color-scheme: dark; }
      * { box-sizing: border-box; }
      html, body { margin: 0; height: 100%; }
      body { display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--surface); }
      header {
        display: flex; align-items: center; gap: 0.25rem; min-width: 0;
        padding: 0.25rem 0.5rem; background: var(--panel); border-bottom: 1px solid var(--line);
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
      #save-status { flex: none; font-size: 0.75rem; color: var(--muted); }
      #save-status[data-failed] { color: var(--danger); }
      h1 {
        flex: 1; min-width: 0; margin: 0 0.5rem; overflow: hidden;
        font-size: 0.875rem; font-weight: 600; white-space: nowrap; text-overflow: ellipsis;
      }
      iframe { width: 100%; height: 100%; border: 0; display: block; background: var(--surface); }
    </style>
  </head>
  <body
    data-key="${item.id}"
    data-item-path="${itemApiPath(item.id)}"
    data-resume-hash="${resumeHash(item)}"
  >
    <header>
      <a id="library" href="/" aria-label="Library" title="Library">${LIBRARY}<span>Library</span></a>
      <button id="back" type="button" aria-label="Back" title="Back (Alt+←)" disabled>${BACK}</button>
      <button id="forward" type="button" aria-label="Forward" title="Forward (Alt+→)" disabled>${FORWARD}</button>
      <h1 title="${item.title}">${item.title}</h1>
      <span id="save-status" role="status"></span>
      <button id="copy-link" type="button" aria-label="Copy link to this view" title="Copy link to this view">${LINK}</button>
    </header>
    <iframe src="${viewer}" title="${item.title}"></iframe>
    <script type="module">${SCRIPT}</script>
  </body>
</html>`;
}
