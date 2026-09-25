// Capture page: every intercepted PDF navigation lands here, except Chrome's top-level ones,
// which become downloads and open this page only to show a failure. It hands a small frame back to
// the browser, or captures the PDF. A captured PDF opens in the desktop window, so the page
// then gets out of the way: a top-level tab goes back to the page the PDF was opened from,
// or closes when it was opened for the PDF alone; a frame keeps one line naming the item.
// A failure stays on screen with a way to open the PDF in the browser instead; a failed
// native open stays on screen too.
import pTimeout from "p-timeout";
import { browser } from "wxt/browser";
import type { CaptureResponse } from "../../../contract/capture";
import { bucketBuild } from "../../bucket-config";
import { failureFromCaptureHash, pdfUrlFromCaptureQuery } from "../../interception";
import {
  type CaptureOutcome,
  CaptureOutcomeSchema,
  DoneReplySchema,
  type Failed,
  failed,
  metadataFailure,
  type RuntimeMessage,
} from "../../messages";

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`capture page is missing #${id}`);
  }
  return found;
}

function link(href: string, text: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = text;
  return anchor;
}

function detail(term: string, value: Node | string): Node[] {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.append(value);
  return [dt, dd];
}

// No answer from the background (none in time, or none at all), or one outside the reply contract.
function unanswered(error: unknown): Failed {
  return failed("extension", `PDF Bucket's extension gave no usable answer: ${String(error)}`);
}

// Opening the PDF natively goes through the background, or the navigation is captured again;
// without the background's answer in time the page reports the failure and stays.
async function openNatively(pdfUrl: URL): Promise<void> {
  const message: RuntimeMessage = { type: "exempt", pdf_url: pdfUrl.href };
  const reply = await pTimeout(browser.runtime.sendMessage(message), {
    milliseconds: bucketBuild.nativeOpenTimeoutMs,
  })
    .then((raw) => DoneReplySchema.parse(raw))
    .catch(unanswered);
  if (reply.kind === "failed") {
    element("capture").dataset.state = "failed";
    renderFailure(pdfUrl, reply.error, "Not opened");
    return;
  }
  location.replace(pdfUrl.href);
}

// A tab opened for the PDF alone (a target=_blank or middle-clicked link, a URL typed into a
// new tab) holds one session-history entry, this page; a tab that followed a link in place
// also holds the linking page (MDN, History.length). This is the rule the browsers apply to
// a tab opened only for a navigation that becomes a download: that tab is closed.
async function leaveTab(pdfUrl: URL): Promise<void> {
  if (history.length > 1) {
    history.back();
    return;
  }
  const message: RuntimeMessage = { type: "close-tab" };
  const reply = await browser.runtime
    .sendMessage(message)
    .then((raw) => DoneReplySchema.parse(raw))
    .catch(unanswered);
  if (reply.kind === "failed") {
    element("capture").dataset.state = "failed";
    renderFailure(pdfUrl, reply.error, "Saved, but this tab could not close");
  }
}

function renderStoredInFrame(response: CaptureResponse): void {
  const reader = link(response.reader_url, response.provenance.title_hint);
  reader.target = "_blank";
  element("heading").replaceChildren(reader);
  const failure = metadataFailure(response);
  if (failure !== null) {
    element("details").replaceChildren(...detail("Metadata", failure));
  }
}

function renderFailure(pdfUrl: URL, error: Failed["error"], heading: string): void {
  document.title = `${heading} · PDF Bucket`;
  element("heading").textContent = heading;
  element("details").replaceChildren(
    ...detail("Error", error.detail),
    ...detail("PDF", pdfUrl.href),
  );
  const native = link(pdfUrl.href, "Open in the browser");
  native.id = "open-natively";
  native.addEventListener("click", (event) => {
    event.preventDefault();
    void openNatively(pdfUrl);
  });
  element("actions").replaceChildren(native);
}

function settle(pdfUrl: URL, outcome: CaptureOutcome, inFrame: boolean): void {
  element("capture").dataset.state = outcome.kind;
  if (outcome.kind === "failed") {
    renderFailure(pdfUrl, outcome.error, "Not saved");
    return;
  }
  if (inFrame) {
    renderStoredInFrame(outcome.response);
    return;
  }
  void leaveTab(pdfUrl);
}

const pdfUrl = pdfUrlFromCaptureQuery(location.search);
const shownFailure = failureFromCaptureHash(location.hash);
const inFrame = window.self !== window.top;
const smallFrame =
  inFrame &&
  (window.innerWidth < bucketBuild.minFrameWidth ||
    window.innerHeight < bucketBuild.minFrameHeight);
if (shownFailure !== null) {
  settle(pdfUrl, shownFailure, inFrame);
} else if (smallFrame) {
  void openNatively(pdfUrl);
} else {
  document.documentElement.dataset.frame = String(inFrame);
  const message: RuntimeMessage = { type: "capture", pdf_url: pdfUrl.href };
  void browser.runtime
    .sendMessage(message)
    .then((raw) => CaptureOutcomeSchema.parse(raw))
    .catch(unanswered)
    .then((outcome) => settle(pdfUrl, outcome, inFrame));
}
