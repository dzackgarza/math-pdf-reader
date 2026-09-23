// Interception per browser, plus the one way back to the browser's own viewer: a (tab, URL)
// exemption, registered when the user opens a PDF natively from the capture page or when
// the capture page sits in a frame too small to read in. It lasts until the tab closes.
import { browser } from "wxt/browser";
import { captureTarget, isPdfResponse, PDF_FRAME_TYPES, pdfCaptureRules } from "./interception";

export type Interception = {
  exempt(tabId: number, pdfUrl: string): Promise<void>;
  release(tabId: number): Promise<void>;
};

function capturePage(): string {
  return browser.runtime.getURL("/capture.html");
}

export async function chromeInterception(bucketOrigin: string): Promise<Interception> {
  const dnr = browser.declarativeNetRequest;
  const rules = pdfCaptureRules(capturePage(), bucketOrigin);
  const stale = await dnr.getDynamicRules();
  await dnr.updateDynamicRules({ removeRuleIds: stale.map((rule) => rule.id), addRules: rules });
  return {
    async exempt(tabId, pdfUrl) {
      const session = await dnr.getSessionRules();
      const id = Math.max(0, ...session.map((rule) => rule.id)) + 1;
      await dnr.updateSessionRules({
        addRules: [
          {
            id,
            priority: rules.length + 1,
            action: { type: "allow" },
            condition: {
              regexFilter: `^${RegExp.escape(pdfUrl)}$`,
              tabIds: [tabId],
              resourceTypes: PDF_FRAME_TYPES,
            },
          },
        ],
      });
    },
    async release(tabId) {
      const session = await dnr.getSessionRules();
      const ids = session
        .filter((rule) => rule.condition.tabIds?.includes(tabId) === true)
        .map((rule) => rule.id);
      await dnr.updateSessionRules({ removeRuleIds: ids });
    },
  };
}

export function firefoxInterception(bucketOrigin: string): Interception {
  const exempted = new Map<number, Set<string>>();
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (
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
