// Capture page: every intercepted PDF navigation lands here. It either hands a small frame
// back to the browser, or captures the PDF and shows the stored item or the failure.
import { browser } from "wxt/browser";
import { bucketBuild } from "../../bucket-config";
import { pdfUrlFromCaptureQuery } from "../../interception";
import { type CaptureOutcome, CaptureOutcomeSchema, type RuntimeMessage } from "../../messages";

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

// Opening the PDF natively goes through the background, or the navigation is captured again.
async function openNatively(pdfUrl: URL): Promise<void> {
  const message: RuntimeMessage = { type: "exempt", pdf_url: pdfUrl.href };
  await browser.runtime.sendMessage(message);
  location.replace(pdfUrl.href);
}

function render(pdfUrl: URL, outcome: CaptureOutcome): void {
  element("capture").dataset.state = outcome.kind;
  if (outcome.kind === "stored") {
    const { response } = outcome;
    const title = response.provenance.title_hint;
    document.title = `${title} · PDF Bucket`;
    element("heading").textContent = response.existing
      ? "Already in PDF Bucket"
      : "Saved to PDF Bucket";
    element("details").replaceChildren(
      ...detail("Title", title),
      ...detail("Reader", link(response.reader_url, response.reader_url)),
      ...detail("Original PDF", response.provenance.pdf_url),
    );
    return;
  }
  document.title = "Not captured · PDF Bucket";
  element("heading").textContent = "PDF Bucket could not capture this PDF";
  const stage =
    outcome.error.stage === "fetch-pdf" ? "Downloading the PDF" : "Sending it to the bucket";
  element("details").replaceChildren(
    ...detail("Failed while", stage),
    ...detail("Error", outcome.error.detail),
    ...detail("Original PDF", pdfUrl.href),
  );
  const native = link(pdfUrl.href, "Open the PDF in the browser instead");
  native.id = "open-natively";
  native.addEventListener("click", (event) => {
    event.preventDefault();
    void openNatively(pdfUrl);
  });
  element("actions").replaceChildren(native);
}

const pdfUrl = pdfUrlFromCaptureQuery(location.search);
const smallFrame =
  window.self !== window.top &&
  (window.innerWidth < bucketBuild.minFrameWidth ||
    window.innerHeight < bucketBuild.minFrameHeight);
if (smallFrame) {
  void openNatively(pdfUrl);
} else {
  element("details").replaceChildren(...detail("Original PDF", pdfUrl.href));
  const message: RuntimeMessage = { type: "capture", pdf_url: pdfUrl.href };
  void browser.runtime
    .sendMessage(message)
    .then((reply) => render(pdfUrl, CaptureOutcomeSchema.parse(reply)));
}
