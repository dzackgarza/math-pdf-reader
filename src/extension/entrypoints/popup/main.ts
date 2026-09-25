// Status page, shown as the toolbar popup and as the options page: whether the bucket answers
// and can store PDFs, this browser's capture switch, and the last capture from this browser.
// Opening it re-reads `/status` and brings the toolbar badge up to date.
import { bucketBuild } from "../../bucket-config";
import {
  type BucketState,
  captureEnabled,
  type LastCapture,
  lastCapture,
  refreshToolbar,
} from "../../bucket-status";
import { metadataFailure } from "../../messages";

const browserName = import.meta.env.FIREFOX ? "Firefox" : "Chrome";

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`status page is missing #${id}`);
  }
  return found;
}

function detail(term: string, value: Node | string, id?: string): Node[] {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.append(value);
  if (id !== undefined) {
    dd.id = id;
  }
  return [dt, dd];
}

function code(text: string): HTMLElement {
  const node = document.createElement("code");
  node.textContent = text;
  return node;
}

const HEADINGS: Record<BucketState["kind"], string> = {
  ready: "Connected to PDF Bucket",
  "not-ready": "Connected, but it cannot store PDFs",
  "check-failed": "Connected, but it cannot tell whether it can store PDFs",
  unreachable: "PDF Bucket is not running",
};

function renderConnection(state: BucketState): void {
  element("connection", HTMLElement).dataset.state = state.kind;
  element("connection-heading", HTMLHeadingElement).textContent = HEADINGS[state.kind];
  const origin = detail("Bucket", bucketBuild.bucketOrigin, "bucket-origin");
  if (state.kind === "check-failed") {
    element("connection-details", HTMLDListElement).replaceChildren(
      ...origin,
      ...detail("Error", state.detail),
    );
    return;
  }
  if (state.kind === "unreachable") {
    element("connection-details", HTMLDListElement).replaceChildren(
      ...origin,
      ...detail("Error", state.detail),
      ...detail("Start it", code("systemctl --user start pdf-bucket")),
    );
    return;
  }
  element("connection-details", HTMLDListElement).replaceChildren(
    ...origin,
    ...detail("Version", state.status.service.version, "bucket-version"),
    ...detail("Data folder", state.status.root, "bucket-root"),
  );
}

function renderSwitch(enabled: boolean): void {
  const box = element("capture-enabled", HTMLInputElement);
  box.checked = enabled;
  box.disabled = false;
  element("capture-label", HTMLSpanElement).textContent = `Capture PDF links in ${browserName}`;
  element("capture-hint", HTMLParagraphElement).textContent = enabled
    ? "PDF links open in PDF Bucket, which keeps a copy."
    : `PDF links open in ${browserName}'s own viewer; nothing is stored.`;
}

function renderLastCapture(last: LastCapture | null): void {
  const container = element("last-capture", HTMLDivElement);
  const line = document.createElement("p");
  if (last === null) {
    line.textContent = `Nothing captured from ${browserName} yet.`;
    container.replaceChildren(line);
    return;
  }
  const when = document.createElement("p");
  when.className = "hint";
  when.textContent = new Date(last.at).toLocaleString();
  if (last.outcome.kind === "stored") {
    const { response } = last.outcome;
    const link = document.createElement("a");
    link.href = response.reader_url;
    link.target = "_blank";
    link.textContent = response.provenance.title_hint;
    line.append(link);
    const failure = metadataFailure(response);
    if (failure !== null) {
      const failed = document.createElement("p");
      failed.className = "failed";
      failed.textContent = `Stored without metadata: ${failure}`;
      container.replaceChildren(line, failed, when);
      return;
    }
    container.replaceChildren(line, when);
    return;
  }
  line.className = "failed";
  line.textContent = `Not captured: ${last.pdf_url} (${last.outcome.error.detail})`;
  container.replaceChildren(line, when);
}

element("open-library", HTMLAnchorElement).href = bucketBuild.bucketOrigin;
element("capture-enabled", HTMLInputElement).addEventListener("change", (event) => {
  const box = event.currentTarget;
  if (!(box instanceof HTMLInputElement)) {
    throw new Error("the capture switch is not a checkbox");
  }
  renderSwitch(box.checked);
  void captureEnabled.setValue(box.checked);
});

void Promise.all([captureEnabled.getValue(), lastCapture.getValue()]).then(([enabled, last]) => {
  renderSwitch(enabled);
  renderLastCapture(last);
});
void refreshToolbar(bucketBuild.bucketOrigin).then(renderConnection);
