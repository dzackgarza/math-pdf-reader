// The page a PDF was linked from. The content script reports every followed link, keyed
// by its absolute URL; the background keeps the most recent ones in extension storage and
// the capture looks the PDF URL up. Neither Chrome's declarativeNetRequest redirect nor the
// referrer policy carries the full linking URL. Background-only: writes are serialized so
// a lookup sees every report that arrived before it.
import { browser } from "wxt/browser";
import { z } from "zod";
import { type LinkOrigin, LinkOriginSchema } from "./messages";

const LinkOriginsSchema = z.record(z.string(), LinkOriginSchema);

const STORAGE_KEY = "linkOrigins";
const KEPT_ORIGINS = 50;

let written = Promise.resolve();

async function linkOrigins(): Promise<Record<string, LinkOrigin>> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  return value === undefined ? {} : LinkOriginsSchema.parse(value);
}

export function rememberLinkOrigin(href: string, origin: LinkOrigin): Promise<void> {
  written = written.then(async () => {
    const kept = Object.entries({ ...(await linkOrigins()), [href]: origin })
      .sort(([, a], [, b]) => b.recorded_at - a.recorded_at)
      .slice(0, KEPT_ORIGINS);
    await browser.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(kept) });
  });
  return written;
}

export async function linkOriginFor(pdfUrl: string): Promise<LinkOrigin | undefined> {
  await written;
  return (await linkOrigins())[pdfUrl];
}
