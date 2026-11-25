import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { MetadataEventSchema } from "../../contract/capture";
import { LIBRARY_VIEW_KEY } from "../../contract/library";
import { onBucketEvent } from "../bucketEvents";
import styles from "../index.css?inline";
import { dropKeptTabs, keepTabs, keptTabs, reloaded } from "../windowTabs";
import { Reader } from "./Reader";

const root = document.getElementById("reader");
if (root === null) {
  throw new Error("the reader page has no #reader element");
}
const key = z.string().min(1).parse(root.dataset.key);

const windowTabs = keptTabs();
if (reloaded() && windowTabs !== null && windowTabs.shown === key) {
  keepTabs({ ...windowTabs, fromReaderReload: true });
  window.location.replace(`/${sessionStorage.getItem(LIBRARY_VIEW_KEY) ?? ""}`);
} else {
  dropKeptTabs();
  showReader(root);
}

function showReader(container: HTMLElement): void {
  const sheet = document.createElement("style");
  sheet.textContent = styles;
  document.head.append(sheet);

  onBucketEvent("metadata", (event) => {
    const { key: resolved, outcome } = MetadataEventSchema.parse(JSON.parse(event.data));
    if (resolved !== key || outcome.status !== "resolved") {
      return;
    }
    document.title = outcome.title;
    const tag = document.querySelector('meta[name="citation_title"]');
    if (tag === null) {
      throw new Error("the reader page has no citation_title tag");
    }
    tag.setAttribute("content", outcome.title);
  });

  const hashPage = /^#page=([1-9][0-9]*)$/.exec(window.location.hash);

  createRoot(container).render(
    <StrictMode>
      <Reader
        shown
        inTab={false}
        onControl={(control) =>
          control.open(key, document.title, hashPage === null ? undefined : Number(hashPage[1]))
        }
        onPage={(_, page) => window.history.replaceState(null, "", `#page=${page}`)}
      />
    </StrictMode>,
  );
}
