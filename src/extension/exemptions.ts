// Interception in Chrome (Firefox: firefox-interception.ts), switched on and off by the
// capture switch, plus the one way back to the browser's own viewer: a (tab, URL) exemption,
// registered when the user opens a PDF natively from the capture page or when the capture
// page sits in a frame too small to read in. It lasts until the tab closes.
import { Mutex } from "async-mutex";
import { browser } from "wxt/browser";
import { type Received, refetchPdf } from "./capture";
import { PDF_FRAME_TYPES, pdfCaptureRules } from "./interception";

export type Interception = {
  setEnabled(enabled: boolean): Promise<void>;
  exempt(tabId: number, pdfUrl: string): Promise<void>;
  release(tabId: number): Promise<void>;
  // The PDF a capture page in (tab, frame) was sent for.
  received(tabId: number, frameId: number, pdfUrl: URL): Promise<Received>;
};

export function capturePage(): string {
  return browser.runtime.getURL("/capture.html");
}

// Chrome: the capture rules are dynamic rules while capture is on and absent while it is off.
// A redirect rule acts on the response headers, and Chrome gives an extension no way to read
// a navigation's body, so the capture fetches the PDF again.
export async function chromeInterception(
  bucketOrigin: string,
  enabled: boolean,
): Promise<Interception> {
  const dnr = browser.declarativeNetRequest;
  const rules = pdfCaptureRules(capturePage(), bucketOrigin);
  // Session rule ids are read, then written: one change at a time, so two exemptions made at
  // once never take the same id.
  const sessionRules = new Mutex();
  const setEnabled = async (on: boolean) => {
    const stale = await dnr.getDynamicRules();
    await dnr.updateDynamicRules({
      removeRuleIds: stale.map((rule) => rule.id),
      addRules: on ? rules : [],
    });
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
                regexFilter: `^${RegExp.escape(pdfUrl)}$`,
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
    received: (_tabId, _frameId, pdfUrl) => refetchPdf(pdfUrl),
  };
}
