/// <reference types="firefox-webext-browser" />
// Firefox interception. Firefox has no response-header rule condition, so a blocking
// webRequest.onHeadersReceived listener makes the decision the Chrome rules make
// (`isPdfResponse`). This module uses Firefox's own `browser` namespace, typed by
// @types/firefox-webext-browser from Firefox's API schemas: there, as MDN documents, a
// blocking listener may return a promise, which the Chrome-derived `wxt/browser` types
// cannot express.
import type { Interception } from "./exemptions";
import { capturePage } from "./exemptions";
import { captureTarget, isPdfResponse, PDF_FRAME_TYPES } from "./interception";

// The listener is registered as the background starts, so no navigation slips past while the
// stored switch is read; it waits for that read and lets every response through while capture
// is off.
export function firefoxInterception(bucketOrigin: string, enabled: Promise<boolean>): Interception {
  const exempted = new Map<number, Set<string>>();
  let on = enabled;
  browser.webRequest.onHeadersReceived.addListener(
    async (details) => {
      if (
        !(await on) ||
        details.method !== "GET" ||
        new URL(details.url).origin === bucketOrigin ||
        exempted.get(details.tabId)?.has(details.url) === true
      ) {
        return {};
      }
      if (details.responseHeaders === undefined) {
        throw new Error("onHeadersReceived was registered with responseHeaders but got none");
      }
      if (!isPdfResponse(details.url, details.responseHeaders)) {
        return {};
      }
      return { redirectUrl: captureTarget(capturePage(), details.url) };
    },
    { urls: ["http://*/*", "https://*/*"], types: PDF_FRAME_TYPES },
    ["blocking", "responseHeaders"],
  );
  return {
    async setEnabled(enabled) {
      on = Promise.resolve(enabled);
    },
    async exempt(tabId, pdfUrl) {
      const urls = exempted.get(tabId);
      if (urls === undefined) {
        exempted.set(tabId, new Set([pdfUrl]));
        return;
      }
      urls.add(pdfUrl);
    },
    async release(tabId) {
      exempted.delete(tabId);
    },
  };
}
