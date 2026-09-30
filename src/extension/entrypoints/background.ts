// Capture background: registers PDF interception for this browser while the capture switch is
// on, records link origins and carries them along redirects, captures PDFs for the capture
// page, sends a tab it captured a PDF in back to the page it left or closes it, hands (tab, URL) pairs back to the
// browser's own viewer when the capture page asks, hands the PDFs Chrome saved as downloads to
// the bucket, sends a window's tabs to the bucket's Import URL, and keeps the toolbar badge in
// step with the bucket and the switch. Every message
// gets exactly one reply; an error in the background is a `failed` reply at stage `extension`.
// Only the extension's own pages may ask for a capture, an exemption, a tab to be left or tabs
// to be sent;
// content scripts, which run in web pages, only report followed links.
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { bucketBuild, newerThanLoaded } from "../bucket-config";
import {
  captureEnabled,
  checkBucket,
  lastCapture,
  refreshToolbar,
  reopenAfterReload,
  staleDetail,
} from "../bucket-status";
import { postDownloadToBucket, postToBucket } from "../capture";
import { type SavedPdf, watchPdfDownloads } from "../chrome-downloads";
import {
  type ChromeInterception,
  capturePage,
  chromeInterception,
  recordCaptureRedirect,
} from "../exemptions";
import { type FirefoxInterception, firefoxInterception } from "../firefox-interception";
import { failureTarget } from "../interception";
import { followRedirect, rememberLinkOrigin, takeLinkOrigin } from "../link-origin";
import {
  type CaptureOutcome,
  type DoneReply,
  failed,
  type RuntimeMessage,
  RuntimeMessageSchema,
} from "../messages";
import { sendWindowTabs } from "../send-tabs";

// How often the badge re-reads `/status` between captures; Chrome's alarm floor is 30 s.
const STATUS_ALARM = "bucket-status";
const STATUS_PERIOD_MINUTES = 1;

const DONE: DoneReply = { kind: "done" };

export default defineBackground(() => {
  // A background restarted from a build written over the loaded one reloads the extension, which
  // then loads that build whole.
  if (newerThanLoaded()) {
    browser.runtime.reload();
    return;
  }
  const { bucketOrigin } = bucketBuild;
  const enabled = captureEnabled.getValue();
  const chrome = import.meta.env.FIREFOX
    ? undefined
    : enabled.then((on) => chromeInterception(bucketOrigin, on));
  const interception: Promise<ChromeInterception | FirefoxInterception> =
    chrome ?? Promise.resolve(firefoxInterception(bucketOrigin, enabled));
  // The bucket check never throws; only the browser refusing a storage read or a badge update
  // rejects here, as an uncaught error in the background.
  const refresh = () => void refreshToolbar(bucketOrigin);

  async function record(pdfUrl: string, outcome: CaptureOutcome): Promise<CaptureOutcome> {
    await lastCapture.setValue({ pdf_url: pdfUrl, at: Date.now(), outcome });
    refresh();
    return outcome;
  }

  // A stale build refuses before it takes the PDF; `record`'s refresh then starts its
  // replacement, after the refusal's reply.
  async function capture(pdfUrl: string, tabId: number, frameId: number): Promise<CaptureOutcome> {
    const state = await checkBucket(bucketOrigin);
    if (state.kind === "stale") {
      return record(pdfUrl, failed("extension", staleDetail(state)));
    }
    const origin = await takeLinkOrigin(pdfUrl);
    const received = await (await interception).received(tabId, frameId, new URL(pdfUrl));
    const outcome =
      received.kind === "failed"
        ? received
        : await postToBucket(new URL(pdfUrl), received.pdf, origin, bucketOrigin);
    return record(pdfUrl, outcome);
  }

  // What became of a download's capture, without its record.
  async function downloadOutcome(saved: SavedPdf): Promise<CaptureOutcome> {
    const state = await checkBucket(bucketOrigin);
    if (state.kind === "stale") {
      return failed("extension", staleDetail(state));
    }
    const origin = await takeLinkOrigin(saved.pdfUrl.href);
    switch (saved.kind) {
      case "interrupted":
        return failed("fetch-pdf", `Chrome could not download the PDF (${saved.reason})`);
      case "lost":
        return failed(
          "extension",
          "Chrome stopped PDF Bucket's extension each time before the bucket answered; the bucket may hold the PDF",
        );
      case "complete":
        return postDownloadToBucket(
          saved.pdfUrl,
          saved.path,
          saved.contentDisposition,
          origin,
          bucketOrigin,
        );
    }
  }

  // Chrome saved a captured PDF as a download: once the bucket holds it, the download goes;
  // otherwise the download stays and a capture page tab shows the failure.
  async function captureDownload(saved: SavedPdf): Promise<void> {
    const pdfUrl = saved.pdfUrl.href;
    const outcome = await record(pdfUrl, await downloadOutcome(saved));
    if (outcome.kind === "stored") {
      await browser.downloads.removeFile(saved.id);
      await browser.downloads.erase({ id: saved.id });
      return;
    }
    const kept = saved.kind === "interrupted" ? "" : `; Chrome saved the PDF at ${saved.path}`;
    const failure = failed(outcome.error.stage, `${outcome.error.detail}${kept}`);
    await browser.tabs.create({ url: failureTarget(capturePage(), pdfUrl, failure) });
  }

  if (chrome !== undefined) {
    watchPdfDownloads(
      (tabId, url) => chrome.then((active) => active.intercepts(tabId, url)),
      captureDownload,
    );
  }

  // A stale build refuses before it sends anything, as a capture does.
  async function sendTabs(windowId: number): Promise<DoneReply> {
    const state = await checkBucket(bucketOrigin);
    if (state.kind === "stale") {
      return failed("extension", staleDetail(state));
    }
    await sendWindowTabs(windowId, bucketOrigin);
    return DONE;
  }

  async function handle(
    message: Exclude<RuntimeMessage, { type: "send-tabs" }>,
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
      case "leave-tab": {
        const active = await interception;
        if (!("leftWebPage" in active)) {
          throw new Error("Chrome saves a top-level PDF as a download; no capture page is left");
        }
        if (message.can_go_back && active.leftWebPage(tabId)) {
          await browser.tabs.goBack(tabId);
        } else {
          await browser.tabs.remove(tabId);
        }
        return DONE;
      }
    }
  }

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const reportFailure = (error: unknown) =>
      sendResponse(failed("extension", `PDF Bucket's extension failed: ${String(error)}`));
    const message = RuntimeMessageSchema.safeParse(raw);
    if (!message.success) {
      reportFailure(message.error);
      return false;
    }
    const fromExtensionPage = sender.url?.startsWith(browser.runtime.getURL("/")) === true;
    if (message.data.type !== "remember-link" && !fromExtensionPage) {
      reportFailure(`a ${message.data.type} message came from ${sender.url ?? "an unknown page"}`);
      return false;
    }
    // The toolbar popup, which sends tabs, is in no tab.
    if (message.data.type === "send-tabs") {
      sendTabs(message.data.window_id).then(sendResponse, reportFailure);
      return true;
    }
    const tabId = sender.tab?.id;
    const { frameId } = sender;
    if (tabId === undefined || frameId === undefined) {
      reportFailure("a runtime message came from outside a tab");
      return false;
    }
    handle(message.data, tabId, frameId).then(sendResponse, reportFailure);
    return true;
  });

  // A followed link's report also names the page for each URL the navigation is redirected to.
  // In Chrome, a capture rule's redirect of a frame to the capture page is recorded too: it is
  // what lets that capture page ask for the PDF.
  browser.webRequest.onBeforeRedirect.addListener(
    (details) => {
      if (/^https?:/.test(details.redirectUrl)) {
        void followRedirect(details.url, details.redirectUrl);
        return;
      }
      if (chrome !== undefined && details.type === "sub_frame") {
        recordCaptureRedirect(details.tabId, details.frameId, details.url, details.redirectUrl);
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

  // A PDF a capture page gave up during the reload opens again, to be captured by this build.
  void reopenAfterReload.getValue().then(async (pdfUrl) => {
    if (pdfUrl !== null) {
      await reopenAfterReload.setValue(null);
      await browser.tabs.create({ url: pdfUrl });
    }
  });

  void browser.alarms.create(STATUS_ALARM, { periodInMinutes: STATUS_PERIOD_MINUTES });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === STATUS_ALARM) {
      refresh();
    }
  });
  refresh();
});
