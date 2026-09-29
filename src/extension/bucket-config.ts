import { browser } from "wxt/browser";

// Values baked in at build time from pdf-bucket.config.json (define in wxt.config.ts).
declare const PDF_BUCKET_BUILD: {
  bucketOrigin: string;
  minFrameWidth: number;
  minFrameHeight: number;
  linkOriginMaxAgeMs: number;
  nativeOpenTimeoutMs: number;
  // The manifest version of the build these files belong to.
  version: string;
};

export const bucketBuild = PDF_BUCKET_BUILD;

// Chromium keeps an unpacked extension's manifest from when it loaded the extension, but reads
// each page, and a restarted background, from the extension's directory. A build written over the
// loaded one therefore runs beside it, and the two halves disagree on their messages, until the
// extension reloads. Such a page or background is one whose baked-in version differs from the
// loaded manifest's.
export function newerThanLoaded(): boolean {
  return bucketBuild.version !== browser.runtime.getManifest().version;
}
