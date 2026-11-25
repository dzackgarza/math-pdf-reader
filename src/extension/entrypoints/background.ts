import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { z } from "zod";
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
import { markPdfResponses, type PdfFrame, type SavedPdf, watchPdfDownloads } from "../downloads";
import { type ChromeInterception, capturePage, chromeInterception } from "../exemptions";
import { type FirefoxInterception, firefoxInterception } from "../firefox-interception";
import { outcomeTarget } from "../interception";
import { followRedirect, rememberLinkOrigin, takeLinkOrigin } from "../link-origin";
import {
  type CaptureOutcome,
  type DoneReply,
  failed,
  type RuntimeMessage,
  RuntimeMessageSchema,
} from "../messages";
import { sendWindowTabs } from "../send-tabs";

const STATUS_ALARM = "bucket-status";
const STATUS_PERIOD_MINUTES = 1;

const DONE: DoneReply = { kind: "done" };

export default defineBackground(() => {
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
  const refresh = () => void refreshToolbar(bucketOrigin);

  async function record(pdfUrl: string, outcome: CaptureOutcome): Promise<CaptureOutcome> {
    await lastCapture.setValue({ pdf_url: pdfUrl, at: Date.now(), outcome });
    refresh();
    return outcome;
  }

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

  async function downloadOutcome(saved: SavedPdf): Promise<CaptureOutcome> {
    const state = await checkBucket(bucketOrigin);
    if (state.kind === "stale") {
      return failed("extension", staleDetail(state));
    }
    const origin = await takeLinkOrigin(saved.pdfUrl.href);
    switch (saved.kind) {
      case "interrupted":
        return failed("fetch-pdf", `the browser could not download the PDF (${saved.reason})`);
      case "lost":
        return failed(
          "extension",
          "the browser stopped Math PDF Reader's extension each time before Math PDF Reader answered; Math PDF Reader may hold the PDF",
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

  const frameTarget = (frame: PdfFrame) => ({ tabId: frame.tab_id, frameIds: [frame.frame_id] });

  async function smallFrame(frame: PdfFrame): Promise<boolean> {
    const [injection] = await browser.scripting.executeScript({
      target: frameTarget(frame),
      func: () => [window.innerWidth, window.innerHeight],
    });
    const [width, height] = z.tuple([z.number(), z.number()]).parse(injection?.result);
    return width < bucketBuild.minFrameWidth || height < bucketBuild.minFrameHeight;
  }

  async function showInFrame(frame: PdfFrame, url: string): Promise<void> {
    await browser.scripting.executeScript({
      target: frameTarget(frame),
      func: (target: string) => location.replace(target),
      args: [url],
    });
  }

  async function discard(saved: SavedPdf): Promise<void> {
    if (saved.kind !== "interrupted") {
      await browser.downloads.removeFile(saved.id);
    }
    await browser.downloads.erase({ id: saved.id });
  }

  async function captureDownload(saved: SavedPdf): Promise<void> {
    const pdfUrl = saved.pdfUrl.href;
    const { frame } = saved;
    if (frame !== null && (await smallFrame(frame))) {
      await discard(saved);
      await (await interception).exempt(frame.tab_id, pdfUrl);
      await showInFrame(frame, pdfUrl);
      return;
    }
    const outcome = await record(pdfUrl, await downloadOutcome(saved));
    if (outcome.kind === "stored") {
      await discard(saved);
      if (frame !== null) {
        await showInFrame(frame, outcomeTarget(capturePage(), pdfUrl, outcome));
      }
      return;
    }
    const kept = saved.kind === "interrupted" ? "" : `; the browser saved the PDF at ${saved.path}`;
    const failure = failed(outcome.error.stage, `${outcome.error.detail}${kept}`);
    const target = outcomeTarget(capturePage(), pdfUrl, failure);
    if (frame === null) {
      await browser.tabs.create({ url: target });
    } else {
      await showInFrame(frame, target);
    }
  }

  if (chrome !== undefined) {
    markPdfResponses((tabId, url) => chrome.then((active) => active.intercepts(tabId, url)));
  }
  watchPdfDownloads(captureDownload);

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
      sendResponse(failed("extension", `Math PDF Reader's extension failed: ${String(error)}`));
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
