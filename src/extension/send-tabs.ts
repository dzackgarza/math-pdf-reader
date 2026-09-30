// Send tabs: each web page tab of a window goes to the bucket's Import URL, one at a time in
// window order. The bucket stores the PDF the tab shows, or the PDF its page names with the
// Highwire `citation_pdf_url` tag (arXiv abstract pages and most journals carry it), and opens
// its reader. A tab whose PDF is stored closes; every other tab stays, and the status page
// lists why each gave no PDF. The bucket's own pages and non-web tabs are not sent.
import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { importToBucket } from "./capture";
import type { ImportOutcome } from "./messages";

export type SentTab = { url: string; title: string; outcome: ImportOutcome };

export type SentTabs = { at: number; tabs: SentTab[] };

// The most recent Send tabs from this browser; null until the first one.
export const lastSentTabs = storage.defineItem<SentTabs | null>("local:lastSentTabs", {
  fallback: null,
});

function sendable(url: URL, bucketOrigin: string): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== bucketOrigin;
}

export async function sendWindowTabs(windowId: number, bucketOrigin: string): Promise<void> {
  const sent: SentTab[] = [];
  for (const tab of await browser.tabs.query({ windowId })) {
    if (tab.url === undefined || !sendable(new URL(tab.url), bucketOrigin)) {
      continue;
    }
    if (tab.id === undefined) {
      throw new Error(`the tab showing ${tab.url} has no id`);
    }
    const outcome = await importToBucket(tab.url, bucketOrigin);
    if (outcome.kind === "stored") {
      await browser.tabs.remove(tab.id);
    }
    sent.push({ url: tab.url, title: tab.title ?? tab.url, outcome });
  }
  await lastSentTabs.setValue({ at: Date.now(), tabs: sent });
}
