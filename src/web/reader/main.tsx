// The reader page, `/read/<key>`: one reader filling the window. The server renders the page's
// head (server/templates/reader.html), with the Highwire `citation_*` tags the Zotero Connector
// reads; the address's `#page=N` names the page shown, so a reload opens the same page.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { MetadataEventSchema } from "../../contract/capture";
import { onBucketEvent } from "../bucketEvents";
import styles from "../index.css?inline";
import { Reader } from "./Reader";

// The page's stylesheet is the library's, which the bundle holds as text: the build names a
// stylesheet that two entries share by its content hash, which the server's page cannot know.
const sheet = document.createElement("style");
sheet.textContent = styles;
document.head.append(sheet);

const root = document.getElementById("reader");
if (root === null) {
  throw new Error("the reader page has no #reader element");
}
const key = z.string().min(1).parse(root.dataset.key);

// A title the metadata resolver finds renames the page, for the window and the Zotero Connector.
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

const HASH_PAGE = /^#page=([1-9][0-9]*)$/;
const hashPage = HASH_PAGE.exec(window.location.hash);

createRoot(root).render(
  <StrictMode>
    <Reader
      itemKey={key}
      openAtPage={hashPage === null ? null : Number(hashPage[1])}
      openAtZoom={null}
      shown
      inTab={false}
      onPage={(page) => window.history.replaceState(null, "", `#page=${page}`)}
    />
  </StrictMode>,
);
