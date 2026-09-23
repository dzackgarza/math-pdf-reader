// Reader page: the prebuilt PDF.js viewer over the stored PDF, with the Highwire
// `citation_*` tags the Zotero Connector's Embedded Metadata translator reads, a bar that
// leads back to the library, and the provenance panel read from the PDF itself.
import { html } from "hono/html";
import prettyBytes from "pretty-bytes";
import type { BucketItem, Collection } from "./libraryContract";

export function pdfUrlPath(key: string): string {
  return `/pdf/${encodeURIComponent(key)}.pdf`;
}

export function readerUrlPath(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

const TOPIC_PREFIX = "topic:";

function capturedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function chips(labels: string[], kind: string) {
  if (labels.length === 0) {
    return html`<span class="none">None</span>`;
  }
  return labels.map((label) => html`<span class="chip ${kind}">${label}</span>`);
}

function fact(label: string, value: unknown) {
  return html`<dt>${label}</dt><dd>${value}</dd>`;
}

function link(url: string) {
  return html`<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`;
}

export function readerPage(item: BucketItem, collections: Collection[], origin: string) {
  const { provenance } = item;
  const title = provenance.title_hint;
  const viewer = `/pdfjs/web/viewer.html?file=${encodeURIComponent(pdfUrlPath(item.id))}`;
  const topics = item.tags
    .filter((tag) => tag.startsWith(TOPIC_PREFIX))
    .map((tag) => tag.slice(TOPIC_PREFIX.length));
  const tags = item.tags.filter((tag) => !tag.startsWith(TOPIC_PREFIX));
  const names = new Map(collections.map((collection) => [collection.id, collection.name]));
  const filedIn = item.collections.map((id) => names.get(id)).filter((name) => name !== undefined);
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="citation_title" content="${title}" />
    <meta name="citation_pdf_url" content="${origin}${pdfUrlPath(item.id)}" />
    <meta name="citation_abstract_html_url" content="${provenance.source_url}" />
    <style>
      :root {
        --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --surface: #f8f9fb;
        --accent: #2563eb; --accent-soft: #eff4ff; --topic-soft: #f3efff; --topic: #6d28d9;
        font-family: Inter, "Segoe UI", system-ui, sans-serif; color: var(--ink);
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; height: 100%; background: var(--surface); }
      body { display: grid; grid-template-rows: auto 1fr; }
      header {
        display: flex; align-items: center; gap: 1rem; padding: 0.625rem 1rem;
        background: #fff; border-bottom: 1px solid var(--line);
      }
      header a.back {
        display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.4rem 0.75rem;
        border: 1px solid var(--line); border-radius: 0.5rem; color: var(--ink);
        text-decoration: none; font-size: 0.875rem; font-weight: 500;
      }
      header a.back:hover { background: var(--surface); }
      header h1 { margin: 0; font-size: 1rem; font-weight: 600; line-height: 1.3; }
      header p { margin: 0; color: var(--muted); font-size: 0.8125rem; }
      main { display: grid; grid-template-columns: minmax(0, 1fr) 22rem; min-height: 0; }
      iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
      aside { overflow-y: auto; background: #fff; border-left: 1px solid var(--line); padding: 1.25rem; }
      aside h2 { margin: 0 0 0.25rem; font-size: 1rem; font-weight: 600; }
      aside h3 { margin: 1.5rem 0 0.625rem; font-size: 0.875rem; font-weight: 600; }
      dl { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: 0.5rem 0.75rem; margin: 0; font-size: 0.8125rem; }
      dt { color: var(--muted); }
      dd { margin: 0; overflow-wrap: anywhere; }
      dd a { color: var(--accent); text-decoration: none; }
      dd a:hover { text-decoration: underline; }
      .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 0.75rem; }
      .chips { display: flex; flex-wrap: wrap; gap: 0.375rem; }
      .chip { padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; background: var(--accent-soft); color: var(--accent); }
      .chip.topic { background: var(--topic-soft); color: var(--topic); }
      .chip.collection { background: #ecfdf3; color: #067647; }
      .none { color: var(--muted); font-size: 0.8125rem; }
      .note { margin: 0 0 0.5rem; padding: 0.625rem 0.75rem; border-radius: 0.5rem; background: #fffbeb; font-size: 0.8125rem; white-space: pre-wrap; }
      .note time { display: block; margin-top: 0.375rem; color: var(--muted); font-size: 0.75rem; }
    </style>
  </head>
  <body>
    <header>
      <a class="back" href="/">&larr; Library</a>
      <div>
        <h1>${title}</h1>
        <p>Captured ${capturedAt(provenance.captured_at)} from ${new URL(provenance.source_url).hostname}</p>
      </div>
    </header>
    <main>
      <iframe src="${viewer}" title="${title}"></iframe>
      <aside aria-label="Provenance">
        <h2>Provenance</h2>
        <h3>Source information</h3>
        <dl>
          ${fact("Source URL", link(provenance.source_url))}
          ${fact("PDF URL", link(provenance.pdf_url))}
        </dl>
        <h3>Capture details</h3>
        <dl>
          ${fact("First captured", capturedAt(provenance.captured_at))}
          ${fact("File path", html`<span class="mono">${item.file.path}</span>`)}
          ${fact("File size", prettyBytes(item.file.sizeBytes))}
          ${fact("Original SHA-256", html`<span class="mono">${provenance.original_sha256}</span>`)}
        </dl>
        <h3>Collections</h3>
        <div class="chips">${chips(filedIn, "collection")}</div>
        <h3>Topics</h3>
        <div class="chips">${chips(topics, "topic")}</div>
        <h3>Tags</h3>
        <div class="chips">${chips(tags, "tag")}</div>
        <h3>Notes</h3>
        ${
          item.notes.length === 0
            ? html`<span class="none">None</span>`
            : item.notes.map(
                (note) =>
                  html`<p class="note">${note.note}<time datetime="${note.dateAdded}">${capturedAt(note.dateAdded)}</time></p>`,
              )
        }
      </aside>
    </main>
  </body>
</html>`;
}
