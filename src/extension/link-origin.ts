// The page a PDF was linked from. The content script reports every followed link, keyed by its
// absolute URL without the fragment (a request URL never carries one); the background carries
// a report along each HTTP redirect of a navigation (a DOI resolver, a publisher's link
// shortener), and the capture takes the report for the PDF URL, once. A report older than the
// link-origin age names no page. Neither Chrome's declarativeNetRequest redirect nor the
// referrer policy carries the full linking URL.
// Reports live in session storage, which the browser clears on restart and on every extension
// update, so no report outlives the build that wrote it. Background-only: storage access is
// serialized by one mutex, so a lookup sees every report that arrived before it, and a failed
// write rejects its own caller without blocking later reports.
import { Mutex } from "async-mutex";
import { storage } from "wxt/utils/storage";
import { z } from "zod";
import { bucketBuild } from "./bucket-config";
import { withoutFragment } from "./interception";
import { type LinkOrigin, LinkOriginSchema } from "./messages";

const LinkOriginsSchema = z.record(z.string(), LinkOriginSchema);

type LinkOrigins = z.infer<typeof LinkOriginsSchema>;

// No report yet is an empty record set.
const reports = storage.defineItem<LinkOrigins>("session:linkOrigins", { fallback: {} });

const lock = new Mutex();

// Runs CHANGE on the reports still within the link-origin age and stores what it returns.
function update<T>(change: (fresh: LinkOrigins) => { kept: LinkOrigins; result: T }): Promise<T> {
  return lock.runExclusive(async () => {
    const oldest = Date.now() - bucketBuild.linkOriginMaxAgeMs;
    const fresh = Object.fromEntries(
      Object.entries(LinkOriginsSchema.parse(await reports.getValue())).filter(
        ([, origin]) => origin.recorded_at >= oldest,
      ),
    );
    const { kept, result } = change(fresh);
    await reports.setValue(kept);
    return result;
  });
}

export function rememberLinkOrigin(href: string, origin: LinkOrigin): Promise<void> {
  return update((fresh) => ({
    kept: { ...fresh, [withoutFragment(href)]: origin },
    result: undefined,
  }));
}

// A navigation redirected from FROM to TO: a report for FROM also names TO's linking page.
export function followRedirect(from: string, to: string): Promise<void> {
  return update((fresh) => {
    const origin = fresh[withoutFragment(from)];
    return {
      kept: origin === undefined ? fresh : { ...fresh, [withoutFragment(to)]: origin },
      result: undefined,
    };
  });
}

export function takeLinkOrigin(pdfUrl: string): Promise<LinkOrigin | undefined> {
  return update((fresh) => {
    const key = withoutFragment(pdfUrl);
    const { [key]: origin, ...rest } = fresh;
    return { kept: rest, result: origin };
  });
}
