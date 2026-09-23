// Reader page: the prebuilt PDF.js viewer over the stored PDF, with the Highwire
// `citation_*` tags the Zotero Connector's Embedded Metadata translator reads.
import { html } from "hono/html";
import type { StoredItem } from "./store";

export function pdfUrlPath(key: string): string {
  return `/pdf/${encodeURIComponent(key)}.pdf`;
}

export function readerUrlPath(key: string): string {
  return `/read/${encodeURIComponent(key)}`;
}

export function readerPage(item: StoredItem, origin: string) {
  const title = item.provenance.title_hint;
  const viewer = `/pdfjs/web/viewer.html?file=${encodeURIComponent(pdfUrlPath(item.key))}`;
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="citation_title" content="${title}" />
    <meta name="citation_pdf_url" content="${origin}${pdfUrlPath(item.key)}" />
    <meta name="citation_abstract_html_url" content="${item.provenance.source_url}" />
    <style>
      html, body, iframe { margin: 0; border: 0; width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <iframe src="${viewer}" title="${title}"></iframe>
  </body>
</html>`;
}
