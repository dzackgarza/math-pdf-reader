// Interception in Chrome (Firefox: firefox-interception.ts), switched on and off by the
// capture switch, plus the one way back to the browser's own viewer: a (tab, URL) exemption,
// registered when the user opens a PDF natively from the capture page or when an intercepted
// PDF sits in a frame too small to read in. It lasts until the tab closes.
import { Mutex } from "async-mutex";
import { browser } from "wxt/browser";
import type { Received } from "./capture";
import type { Intercepts } from "./downloads";
import { PDF_FRAME_TYPES, pdfCaptureRules } from "./interception";
import { failed } from "./messages";

export type Interception = {
  setEnabled(enabled: boolean): Promise<void>;
  exempt(tabId: number, pdfUrl: string): Promise<void>;
  release(tabId: number): Promise<void>;
  // The PDF a capture page in (tab, frame) was sent for.
  received(tabId: number, frameId: number, pdfUrl: URL): Promise<Received>;
};

export type ChromeInterception = Interception & { intercepts: Intercepts };

export function capturePage(): string {
  return browser.runtime.getURL("/capture.html");
}

// The exempted URL as a declarativeNetRequest `urlFilter` anchored at both ends. A regexFilter
// must compile to less than 2 KB in RE2, which a long signed URL exceeds; a urlFilter has no
// such limit. It has no escape either: a `*` or `^` in the URL is a wildcard or a separator
// there, so the exemption can also cover a few other URLs in the same tab.
function exemption(pdfUrl: string): string {
  return `|${pdfUrl}|`;
}

// Chrome: the capture rules are dynamic rules while capture is on and absent while it is off.
// A PDF navigation becomes a download the background hands to the bucket (downloads.ts), so no
// capture page asks Chrome's background for a PDF.
export async function chromeInterception(
  bucketOrigin: string,
  enabled: boolean,
): Promise<ChromeInterception> {
  const dnr = browser.declarativeNetRequest;
  const rules = pdfCaptureRules(bucketOrigin);
  let capturing = enabled;
  // Session rule ids are read, then written: one change at a time, so two exemptions made at
  // once never take the same id.
  const sessionRules = new Mutex();
  const setEnabled = async (on: boolean) => {
    const stale = await dnr.getDynamicRules();
    await dnr.updateDynamicRules({
      removeRuleIds: stale.map((rule) => rule.id),
      addRules: on ? rules : [],
    });
    capturing = on;
  };
  await setEnabled(enabled);
  return {
    setEnabled,
    exempt: (tabId, pdfUrl) =>
      sessionRules.runExclusive(async () => {
        const session = await dnr.getSessionRules();
        const id = Math.max(0, ...session.map((rule) => rule.id)) + 1;
        await dnr.updateSessionRules({
          addRules: [
            {
              id,
              priority: rules.length + 1,
              action: { type: "allow" },
              condition: {
                urlFilter: exemption(pdfUrl),
                isUrlFilterCaseSensitive: true,
                tabIds: [tabId],
                resourceTypes: PDF_FRAME_TYPES,
              },
            },
          ],
        });
      }),
    release: (tabId) =>
      sessionRules.runExclusive(async () => {
        const session = await dnr.getSessionRules();
        const ids = session
          .filter((rule) => rule.condition.tabIds?.includes(tabId) === true)
          .map((rule) => rule.id);
        await dnr.updateSessionRules({ removeRuleIds: ids });
      }),
    // The capture page is web-accessible, so any web page can frame it with a PDF URL of its
    // choice; only that page asks.
    received: async () =>
      failed(
        "fetch-pdf",
        "PDF Bucket did not send this frame to the capture page (the page was opened " +
          "directly, or reopened from the history). Follow the link to the PDF again.",
      ),
    intercepts: async (tabId, url) => {
      if (!capturing || url.startsWith(`${bucketOrigin}/`)) {
        return false;
      }
      const session = await dnr.getSessionRules();
      return !session.some(
        (rule) =>
          rule.condition.tabIds?.includes(tabId) === true &&
          rule.condition.urlFilter === exemption(url),
      );
    },
  };
}
