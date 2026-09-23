// Capture background: registers PDF interception for this browser, records link origins,
// captures PDFs for the capture page, and hands (tab, URL) pairs back to the browser's own
// viewer when the capture page asks.
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { bucketBuild } from "../bucket-config";
import { capturePdf } from "../capture";
import { chromeInterception, firefoxInterception } from "../exemptions";
import { linkOriginFor, rememberLinkOrigin } from "../link-origin";
import { type CaptureOutcome, type RuntimeMessage, RuntimeMessageSchema } from "../messages";

export default defineBackground(() => {
  const interception = import.meta.env.FIREFOX
    ? Promise.resolve(firefoxInterception(bucketBuild.bucketOrigin))
    : chromeInterception(bucketBuild.bucketOrigin);

  async function handle(message: RuntimeMessage, tabId: number): Promise<CaptureOutcome | null> {
    switch (message.type) {
      case "remember-link":
        await rememberLinkOrigin(message.href, message.origin);
        return null;
      case "capture": {
        const origin = await linkOriginFor(message.pdf_url);
        return capturePdf(new URL(message.pdf_url), origin, bucketBuild.bucketOrigin);
      }
      case "exempt":
        await (await interception).exempt(tabId, message.pdf_url);
        return null;
    }
  }

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      throw new Error("runtime message sent from outside a tab");
    }
    void handle(RuntimeMessageSchema.parse(raw), tabId).then(sendResponse);
    return true;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void interception.then((active) => active.release(tabId));
  });
});
