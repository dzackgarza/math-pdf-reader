// Capture background: registers PDF interception for this browser while the capture switch is
// on, records link origins, captures PDFs for the capture page, closes a tab opened only for a
// captured PDF, hands (tab, URL) pairs back to the browser's own viewer when the capture page
// asks, and keeps the toolbar badge in step with the bucket and the switch.
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { bucketBuild } from "../bucket-config";
import { captureEnabled, lastCapture, refreshToolbar } from "../bucket-status";
import { capturePdf } from "../capture";
import { chromeInterception } from "../exemptions";
import { firefoxInterception } from "../firefox-interception";
import { linkOriginFor, rememberLinkOrigin } from "../link-origin";
import { type CaptureOutcome, type RuntimeMessage, RuntimeMessageSchema } from "../messages";

// How often the badge re-reads `/status` between captures; Chrome's alarm floor is 30 s.
const STATUS_ALARM = "bucket-status";
const STATUS_PERIOD_MINUTES = 1;

export default defineBackground(() => {
  const { bucketOrigin } = bucketBuild;
  const enabled = captureEnabled.getValue();
  const interception = import.meta.env.FIREFOX
    ? Promise.resolve(firefoxInterception(bucketOrigin, enabled))
    : enabled.then((on) => chromeInterception(bucketOrigin, on));
  const refresh = () => void refreshToolbar(bucketOrigin);

  async function capture(pdfUrl: string): Promise<CaptureOutcome> {
    const origin = await linkOriginFor(pdfUrl);
    const outcome = await capturePdf(new URL(pdfUrl), origin, bucketOrigin);
    await lastCapture.setValue({ pdf_url: pdfUrl, at: Date.now(), outcome });
    refresh();
    return outcome;
  }

  async function handle(message: RuntimeMessage, tabId: number): Promise<CaptureOutcome | null> {
    switch (message.type) {
      case "remember-link":
        await rememberLinkOrigin(message.href, message.origin);
        return null;
      case "capture":
        return capture(message.pdf_url);
      case "exempt":
        await (await interception).exempt(tabId, message.pdf_url);
        return null;
      case "close-tab":
        await browser.tabs.remove(tabId);
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

  captureEnabled.watch((enabled) => {
    void interception.then((active) => active.setEnabled(enabled)).then(refresh);
  });

  void browser.alarms.create(STATUS_ALARM, { periodInMinutes: STATUS_PERIOD_MINUTES });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === STATUS_ALARM) {
      refresh();
    }
  });
  refresh();
});
