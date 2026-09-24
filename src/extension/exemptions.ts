// Interception in Chrome (Firefox: firefox-interception.ts), switched on and off by the
// capture switch, plus the one way back to the browser's own viewer: a (tab, URL) exemption,
// registered when the user opens a PDF natively from the capture page or when the capture
// page sits in a frame too small to read in. It lasts until the tab closes.
import { browser } from "wxt/browser";
import { PDF_FRAME_TYPES, pdfCaptureRules } from "./interception";

export type Interception = {
  setEnabled(enabled: boolean): Promise<void>;
  exempt(tabId: number, pdfUrl: string): Promise<void>;
  release(tabId: number): Promise<void>;
};

export function capturePage(): string {
  return browser.runtime.getURL("/capture.html");
}

// Chrome: the capture rules are dynamic rules while capture is on and absent while it is off.
export async function chromeInterception(
  bucketOrigin: string,
  enabled: boolean,
): Promise<Interception> {
  const dnr = browser.declarativeNetRequest;
  const rules = pdfCaptureRules(capturePage(), bucketOrigin);
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
