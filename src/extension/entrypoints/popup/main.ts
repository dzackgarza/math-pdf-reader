// Status page, shown as the toolbar popup and as the options page: whether the bucket answers
// and can store PDFs, this browser's capture switch, the last capture from this browser, and
// Send tabs with the result of its last run.
// Opening it re-reads `/status` and brings the toolbar badge up to date.
import { browser } from "wxt/browser";
import { bucketBuild, newerThanLoaded } from "../../bucket-config";
import {
  type BucketState,
  captureEnabled,
  type LastCapture,
  lastCapture,
  refreshToolbar,
} from "../../bucket-status";
import { DoneReplySchema, failed, type RuntimeMessage } from "../../messages";
import { lastSentTabs, type SentTabs } from "../../send-tabs";

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
  stale: "This extension is not the build PDF Bucket was provisioned with",
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
  if (state.kind === "stale") {
    element("connection-details", HTMLDListElement).replaceChildren(
      ...origin,
      ...detail("This build", state.own),
      ...detail("Provisioned", state.provisioned),
      ...detail("Replacement", state.replacement),
    );
    return;
  }
  if (state.kind === "unreachable") {
    element("connection-details", HTMLDListElement).replaceChildren(
      ...origin,
      ...detail("Error", state.detail),
      ...detail("Start it", code("gtk-launch pdf-bucket-desktop")),
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
    container.replaceChildren(line, when);
    return;
  }
  line.className = "failed";
  line.textContent = `Not captured: ${last.pdf_url} (${last.outcome.error.detail})`;
  container.replaceChildren(line, when);
}

function renderSentTabs(sent: SentTabs | null): void {
  const container = element("sent-tabs", HTMLDivElement);
  if (sent === null) {
    container.replaceChildren();
    return;
  }
  const failures = sent.tabs.flatMap(({ url, title, outcome }) =>
    outcome.kind === "failed" ? [{ url, title, detail: outcome.error.detail }] : [],
  );
  const summary = document.createElement("p");
  summary.id = "sent-summary";
  summary.textContent = `Stored ${sent.tabs.length - failures.length} of ${sent.tabs.length} tabs.`;
  const when = document.createElement("p");
  when.className = "hint";
  when.textContent = new Date(sent.at).toLocaleString();
  const list = document.createElement("ul");
  list.id = "not-sent";
  list.replaceChildren(
    ...failures.map(({ url, title, detail }) => {
      const item = document.createElement("li");
      item.className = "failed";
      item.dataset.url = url;
      item.textContent = `${title}: ${detail}`;
      return item;
    }),
  );
  container.replaceChildren(summary, when, list);
}

function renderSendFailure(detail: string): void {
  const line = document.createElement("p");
  line.className = "failed";
  line.textContent = `Not sent: ${detail}`;
  element("sent-tabs", HTMLDivElement).replaceChildren(line);
}

// The background sends the tabs, so the work goes on when this popup closes; the list is
// rendered from the stored result.
async function sendTabs(): Promise<void> {
  const button = element("send-tabs", HTMLButtonElement);
  const section = element("tabs", HTMLElement);
  button.disabled = true;
  section.dataset.state = "sending";
  const current = await browser.windows.getCurrent();
  if (current.id === undefined) {
    throw new Error("the status page's window has no id");
  }
  const message: RuntimeMessage = { type: "send-tabs", window_id: current.id };
  const reply = await browser.runtime
    .sendMessage(message)
    .then((raw) => DoneReplySchema.parse(raw))
    .catch((error: unknown) =>
      failed("extension", `PDF Bucket's extension gave no usable answer: ${String(error)}`),
    );
  if (reply.kind === "failed") {
    renderSendFailure(reply.error.detail);
  } else {
    renderSentTabs(await lastSentTabs.getValue());
  }
  button.disabled = false;
  section.dataset.state = reply.kind;
}

// A status page from a build written over the loaded extension reloads the extension, which
// closes the page; the next one shows the new build.
if (newerThanLoaded()) {
  browser.runtime.reload();
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

element("send-tabs", HTMLButtonElement).addEventListener("click", () => void sendTabs());

void Promise.all([captureEnabled.getValue(), lastCapture.getValue(), lastSentTabs.getValue()]).then(
  ([enabled, last, sent]) => {
    renderSwitch(enabled);
    renderLastCapture(last);
    renderSentTabs(sent);
  },
);
void refreshToolbar(bucketBuild.bucketOrigin).then(renderConnection);
