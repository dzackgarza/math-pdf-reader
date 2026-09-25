/// <reference types="firefox-webext-browser" />
// Firefox interception. Firefox has no response-header rule condition, so a blocking
// webRequest.onHeadersReceived listener makes the decision the Chrome rules make
// (`isPdfResponse`). This module uses Firefox's own `browser` namespace, typed by
// @types/firefox-webext-browser from Firefox's API schemas: there, as MDN documents, a
// blocking listener may return a promise, which the Chrome-derived `wxt/browser` types
// cannot express.
//
// The capture keeps the navigation's own response, so a signed or single-use URL, the tab's
// container cookies and the site's session all hold: a StreamFilter (MDN,
// webRequest.filterResponseData) takes the PDF's bytes, and the frame receives instead a short
// HTML document that, once the response has ended, replaces itself with the capture page. The
// response headers are rewritten to fit that document: an HTML type, no length, no
// attachment disposition, and no Content-Security-Policy to refuse its script.
import type { Received } from "./capture";
import type { Interception } from "./exemptions";
import { capturePage } from "./exemptions";
import { captureTarget, isPdfResponse, PDF_FRAME_TYPES, withoutFragment } from "./interception";
import { failed } from "./messages";

type HttpHeaders = browser.webRequest.HttpHeaders;

const REPLACED_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "content-security-policy",
  "content-security-policy-report-only",
]);

function asHtml(headers: HttpHeaders): HttpHeaders {
  return [
    ...headers.filter((header) => !REPLACED_HEADERS.has(header.name.toLowerCase())),
    { name: "Content-Type", value: "text/html; charset=utf-8" },
  ];
}

// The document the frame shows while the PDF arrives. Its load event fires when the response
// ends, completed or cut off, and the capture page then reports which.
function savingDocument(target: string): Uint8Array {
  const script = JSON.stringify(target).replaceAll("<", "\\u003c");
  return new TextEncoder().encode(
    '<!doctype html><meta charset="utf-8"><title>Saving… · PDF Bucket</title>' +
      "<p>Saving the PDF to PDF Bucket…</p>" +
      `<script>addEventListener("load", () => location.replace(${script}));</script>`,
  );
}

function header(headers: HttpHeaders, name: string): string | null {
  const found = headers.find((candidate) => candidate.name.toLowerCase() === name);
  return found?.value === undefined ? null : found.value;
}

// The response's bytes, collected by a filter that writes DOCUMENT in their place.
function keepBody(
  requestId: string,
  document: Uint8Array,
  headers: HttpHeaders,
): Promise<Received> {
  const filter = browser.webRequest.filterResponseData(requestId);
  const chunks: ArrayBuffer[] = [];
  return new Promise((resolve) => {
    filter.onstart = () => filter.write(document);
    filter.ondata = (event) => chunks.push(event.data);
    filter.onstop = () => {
      filter.close();
      resolve({
        kind: "received",
        pdf: {
          bytes: new Blob(chunks, { type: "application/pdf" }),
          contentDisposition: header(headers, "content-disposition"),
        },
      });
    };
    filter.onerror = () => resolve(failed("fetch-pdf", filter.error));
  });
}

const heldKey = (tabId: number, frameId: number, pdfUrl: string) =>
  JSON.stringify([tabId, frameId, pdfUrl]);

// The listener is registered as the background starts, so no navigation slips past while the
// stored switch is read; it waits for that read and lets every response through while capture
// is off.
export function firefoxInterception(bucketOrigin: string, enabled: Promise<boolean>): Interception {
  const exempted = new Map<number, Set<string>>();
  // Responses kept for a capture page not yet asking, by (tab, frame, PDF URL).
  const held = new Map<string, { tabId: number; pdfUrl: string; body: Promise<Received> }>();
  let on = enabled;
  const forget = (keep: (entry: { tabId: number; pdfUrl: string }) => boolean) => {
    for (const [key, entry] of held) {
      if (!keep(entry)) {
        held.delete(key);
      }
    }
  };
  browser.webRequest.onHeadersReceived.addListener(
    async (details) => {
      // Firefox reports a document request with the fragment of the URL it was opened at.
      const pdfUrl = withoutFragment(details.url);
      if (
        !(await on) ||
        details.method !== "GET" ||
        new URL(details.url).origin === bucketOrigin ||
        exempted.get(details.tabId)?.has(pdfUrl) === true
      ) {
        return {};
      }
      if (details.responseHeaders === undefined) {
        throw new Error("onHeadersReceived was registered with responseHeaders but got none");
      }
      if (!isPdfResponse(details.url, details.responseHeaders)) {
        return {};
      }
      const document = savingDocument(captureTarget(capturePage(), pdfUrl));
      held.set(heldKey(details.tabId, details.frameId, pdfUrl), {
        tabId: details.tabId,
        pdfUrl,
        body: keepBody(details.requestId, document, details.responseHeaders),
      });
      return { responseHeaders: asHtml(details.responseHeaders) };
    },
    { urls: ["http://*/*", "https://*/*"], types: PDF_FRAME_TYPES },
    ["blocking", "responseHeaders"],
  );
  return {
    async setEnabled(enabled) {
      on = Promise.resolve(enabled);
    },
    async exempt(tabId, pdfUrl) {
      forget((entry) => entry.tabId !== tabId || entry.pdfUrl !== pdfUrl);
      const urls = exempted.get(tabId);
      if (urls === undefined) {
        exempted.set(tabId, new Set([pdfUrl]));
        return;
      }
      urls.add(pdfUrl);
    },
    async release(tabId) {
      exempted.delete(tabId);
      forget((entry) => entry.tabId !== tabId);
    },
    async received(tabId, frameId, pdfUrl) {
      const key = heldKey(tabId, frameId, pdfUrl.href);
      const entry = held.get(key);
      if (entry === undefined) {
        return failed(
          "fetch-pdf",
          "This page no longer holds the PDF the browser received (it was reopened from the " +
            "history). Follow the link to the PDF again.",
        );
      }
      held.delete(key);
      return entry.body;
    },
  };
}
