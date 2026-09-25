// Capture background: registers PDF interception for this browser while the capture switch is
// on, records link origins and carries them along redirects, captures PDFs for the capture
// page, closes a tab opened only for a captured PDF, hands (tab, URL) pairs back to the
// browser's own viewer when the capture page asks, hands the PDFs Chrome saved as downloads to
// the bucket, and keeps the toolbar badge in step with the bucket and the switch. Every message
// gets exactly one reply; an error in the background is a `failed` reply at stage `extension`.
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { bucketBuild } from "../bucket-config";
import { captureEnabled, lastCapture, refreshToolbar } from "../bucket-status";
import { postDownloadToBucket, postToBucket } from "../capture";
import { type SavedPdf, watchPdfDownloads } from "../chrome-downloads";
import { capturePage, chromeInterception, type Interception } from "../exemptions";
import { firefoxInterception } from "../firefox-interception";
import { failureTarget } from "../interception";
import { followRedirect, rememberLinkOrigin, takeLinkOrigin } from "../link-origin";
import {
  type CaptureOutcome,
  type DoneReply,
  failed,
  type RuntimeMessage,
  RuntimeMessageSchema,
} from "../messages";

// How often the badge re-reads `/status` between captures; Chrome's alarm floor is 30 s.
const STATUS_ALARM = "bucket-status";
const STATUS_PERIOD_MINUTES = 1;

const DONE: DoneReply = { kind: "done" };

export default defineBackground(() => {
  const { bucketOrigin } = bucketBuild;
  const enabled = captureEnabled.getValue();
  const chrome = import.meta.env.FIREFOX
    ? undefined
    : enabled.then((on) => chromeInterception(bucketOrigin, on));
  const interception: Promise<Interception> =
    chrome ?? Promise.resolve(firefoxInterception(bucketOrigin, enabled));
  // The bucket check never throws; only the browser refusing a storage read or a badge update
  // rejects here, as an uncaught error in the background.
  const refresh = () => void refreshToolbar(bucketOrigin);

  async function record(pdfUrl: string, outcome: CaptureOutcome): Promise<CaptureOutcome> {
    await lastCapture.setValue({ pdf_url: pdfUrl, at: Date.now(), outcome });
    refresh();
    return outcome;
  }

  async function capture(pdfUrl: string, tabId: number, frameId: number): Promise<CaptureOutcome> {
    const origin = await takeLinkOrigin(pdfUrl);
    const received = await (await interception).received(tabId, frameId, new URL(pdfUrl));
    const outcome =
      received.kind === "failed"
        ? received
        : await postToBucket(new URL(pdfUrl), received.pdf, origin, bucketOrigin);
    return record(pdfUrl, outcome);
  }

  // Chrome saved a captured PDF as a download: once the bucket holds it, the download goes;
  // otherwise the download stays and a capture page tab shows the failure.
  async function captureDownload(saved: SavedPdf): Promise<void> {
    const pdfUrl = saved.pdfUrl.href;
    const origin = await takeLinkOrigin(pdfUrl);
    const outcome = await record(
      pdfUrl,
      saved.kind === "interrupted"
        ? failed("fetch-pdf", `Chrome could not download the PDF (${saved.reason})`)
        : await postDownloadToBucket(
            saved.pdfUrl,
            saved.path,
            saved.contentDisposition,
            origin,
            bucketOrigin,
          ),
    );
    if (outcome.kind === "stored") {
      await browser.downloads.removeFile(saved.id);
      await browser.downloads.erase({ id: saved.id });
      return;
    }
    const kept = saved.kind === "complete" ? `; Chrome saved the PDF at ${saved.path}` : "";
    const failure = failed(outcome.error.stage, `${outcome.error.detail}${kept}`);
    await browser.tabs.create({ url: failureTarget(capturePage(), pdfUrl, failure) });
  }

  if (chrome !== undefined) {
    watchPdfDownloads(
      (tabId, url) => chrome.then((active) => active.intercepts(tabId, url)),
      captureDownload,
    );
  }

  async function handle(
    message: RuntimeMessage,
    tabId: number,
    frameId: number,
  ): Promise<CaptureOutcome | DoneReply> {
    switch (message.type) {
      case "remember-link":
        await rememberLinkOrigin(message.href, message.origin);
        return DONE;
      case "capture":
        return capture(message.pdf_url, tabId, frameId);
      case "exempt":
        await (await interception).exempt(tabId, message.pdf_url);
        return DONE;
      case "close-tab":
        await browser.tabs.remove(tabId);
        return DONE;
    }
  }

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const reportFailure = (error: unknown) =>
      sendResponse(failed("extension", `PDF Bucket's extension failed: ${String(error)}`));
    const tabId = sender.tab?.id;
    const { frameId } = sender;
    if (tabId === undefined || frameId === undefined) {
      reportFailure("a runtime message came from outside a tab");
      return false;
    }
    const message = RuntimeMessageSchema.safeParse(raw);
    if (!message.success) {
      reportFailure(message.error);
      return false;
    }
    handle(message.data, tabId, frameId).then(sendResponse, reportFailure);
    return true;
  });

  // A followed link's report also names the page for each URL the navigation is redirected to.
  browser.webRequest.onBeforeRedirect.addListener(
    (details) => {
      if (/^https?:/.test(details.redirectUrl)) {
        void followRedirect(details.url, details.redirectUrl);
      }
    },
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame", "sub_frame"] },
  );

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
