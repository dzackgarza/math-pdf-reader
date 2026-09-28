// Chrome: a top-level PDF navigation becomes a download (interception.ts), because Chrome
// gives an extension no way to read a navigation's response body. The PDF is then fetched once,
// so a signed or single-use URL holds. The navigation's response headers mark its URL as a
// capture (the decision the rules made, `isPdfResponse`); the download Chrome starts for that
// URL takes the mark, and once the file is complete the background hands its path to the
// bucket. A download without a mark (a link the user saved, a PDF opened natively) is left
// alone.
// Marks and claims live in session storage, so a service worker that stops between the response
// and the download keeps them. One mutex serializes every change, as in link-origin.ts.
// A claim stays until its capture has an outcome. Chrome stops a service worker whose `fetch()`
// response takes more than 30 seconds (developer.chrome.com, "The extension service worker
// lifecycle"), and the bucket answers a capture only once the PDF is stored. So a claim whose
// delivery began in a worker that stopped is delivered again when the next worker starts: the
// bucket keeps identical bytes as one item and answers a repeat at once. A claim whose deliveries
// were lost MAX_DELIVERIES times is handed on as lost, which the background shows as a failure.
import { Mutex } from "async-mutex";
import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { z } from "zod";
import { bucketBuild } from "./bucket-config";
import { isPdfResponse, withoutFragment } from "./interception";

// A navigation to a PDF URL (without fragment) still waiting for its download, oldest first.
const MarkSchema = z.strictObject({
  pdf_url: z.string(),
  content_disposition: z.string().nullable(),
  recorded_at: z.number(),
});

const MarksSchema = z.array(MarkSchema);

// Download id to the PDF URL it saves, the Content-Disposition it came with, and how many
// deliveries of its capture have begun (0 while Chrome still downloads it).
const DownloadsSchema = z.record(
  z.string(),
  z.strictObject({
    pdf_url: z.string(),
    content_disposition: z.string().nullable(),
    deliveries: z.number().int().nonnegative(),
  }),
);

const MAX_DELIVERIES = 2;

type Marks = z.infer<typeof MarksSchema>;
type Downloads = z.infer<typeof DownloadsSchema>;

const navigations = storage.defineItem<Marks>("session:pdfNavigations", { fallback: [] });
const downloads = storage.defineItem<Downloads>("session:pdfDownloads", { fallback: {} });

const lock = new Mutex();

// A completed download of a captured navigation, or one Chrome gave up on.
export type SavedPdf =
  | {
      kind: "complete";
      id: number;
      pdfUrl: URL;
      path: string;
      contentDisposition: string | null;
    }
  | { kind: "interrupted"; id: number; pdfUrl: URL; reason: string }
  // Every delivery began in a service worker that stopped before the bucket answered.
  | { kind: "lost"; id: number; pdfUrl: URL; path: string };

// Whether a navigation of TAB to URL is captured now: capture is on, and neither the bucket's
// own origin nor an exemption lets it through.
export type Intercepts = (tabId: number, url: string) => Promise<boolean>;

// The mark is queued when the response arrives, so the download's claim, queued later, sees it.
// Marks older than the link-origin age are dropped: their navigation never became a download.
function mark(
  captured: () => Promise<boolean>,
  url: string,
  contentDisposition: string | null,
): Promise<void> {
  return lock.runExclusive(async () => {
    if (!(await captured())) {
      return;
    }
    const oldest = Date.now() - bucketBuild.linkOriginMaxAgeMs;
    const fresh = MarksSchema.parse(await navigations.getValue()).filter(
      (each) => each.recorded_at >= oldest,
    );
    await navigations.setValue([
      ...fresh,
      { pdf_url: url, content_disposition: contentDisposition, recorded_at: Date.now() },
    ]);
  });
}

// The download ID saves URL: it takes the oldest mark for URL, if any.
function claim(id: number, url: string): Promise<void> {
  return lock.runExclusive(async () => {
    const pending = MarksSchema.parse(await navigations.getValue());
    const index = pending.findIndex((each) => each.pdf_url === url);
    const taken = pending[index];
    if (taken === undefined) {
      return;
    }
    await navigations.setValue(pending.toSpliced(index, 1));
    const claimed = DownloadsSchema.parse(await downloads.getValue());
    await downloads.setValue({
      ...claimed,
      [String(id)]: { pdf_url: url, content_disposition: taken.content_disposition, deliveries: 0 },
    });
  });
}

// The first delivery of download ID's capture begins: its claim, unless the download has none or
// its delivery has already begun (Chrome reports a state change once, but a worker that started
// meanwhile may have resumed it).
function begin(id: number): Promise<Downloads[string] | undefined> {
  return lock.runExclusive(async () => {
    const claimed = DownloadsSchema.parse(await downloads.getValue());
    const taken = claimed[String(id)];
    if (taken === undefined || taken.deliveries > 0) {
      return undefined;
    }
    const begun = { ...taken, deliveries: 1 };
    await downloads.setValue({ ...claimed, [String(id)]: begun });
    return begun;
  });
}

// The claims whose delivery began in a worker that stopped, each counted as begun once more.
// It runs first at worker start, before this worker can begin a delivery of its own.
function resume(): Promise<[number, Downloads[string]][]> {
  return lock.runExclusive(async () => {
    const claimed = DownloadsSchema.parse(await downloads.getValue());
    const left = Object.entries(claimed)
      .filter(([, taken]) => taken.deliveries > 0)
      .map(([id, taken]): [number, Downloads[string]] => [
        Number(id),
        { ...taken, deliveries: taken.deliveries + 1 },
      ]);
    await downloads.setValue({ ...claimed, ...Object.fromEntries(left) });
    return left;
  });
}

// Download ID's capture has an outcome.
function release(id: number): Promise<void> {
  return lock.runExclusive(async () => {
    const claims = DownloadsSchema.parse(await downloads.getValue());
    await downloads.setValue(
      Object.fromEntries(Object.entries(claims).filter(([claimed]) => claimed !== String(id))),
    );
  });
}

// Hands download ID's capture to SAVED, then drops its claim.
async function deliver(
  id: number,
  claimed: Downloads[string],
  saved: (pdf: SavedPdf) => Promise<void>,
): Promise<void> {
  const [item] = await browser.downloads.search({ id });
  if (item === undefined) {
    await release(id);
    throw new Error(`Chrome no longer lists download ${id}`);
  }
  const pdfUrl = new URL(claimed.pdf_url);
  if (claimed.deliveries > MAX_DELIVERIES) {
    await saved({ kind: "lost", id, pdfUrl, path: item.filename });
  } else if (item.state === "complete") {
    await saved({
      kind: "complete",
      id,
      pdfUrl,
      path: item.filename,
      contentDisposition: claimed.content_disposition,
    });
  } else if (item.state === "interrupted") {
    // Chrome names the interrupt reason of every interrupted download.
    if (item.error === undefined) {
      throw new Error(`Chrome interrupted download ${id} without a reason`);
    }
    await saved({ kind: "interrupted", id, pdfUrl, reason: item.error });
  } else {
    throw new Error(`download ${id} is delivered while Chrome says it is ${item.state}`);
  }
  await release(id);
}

export function watchPdfDownloads(
  intercepts: Intercepts,
  saved: (pdf: SavedPdf) => Promise<void>,
): void {
  void resume().then((left) =>
    Promise.all(left.map(([id, claimed]) => deliver(id, claimed, saved))),
  );

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      // Asked for with "responseHeaders", so Chrome always gives them.
      const headers = details.responseHeaders;
      if (headers === undefined) {
        throw new Error(`Chrome gave no response headers for ${details.url}`);
      }
      if (details.method !== "GET" || !isPdfResponse(details.url, headers)) {
        return undefined;
      }
      const url = withoutFragment(details.url);
      const disposition = headers.find(
        (header) => header.name.toLowerCase() === "content-disposition",
      );
      void mark(
        () => intercepts(details.tabId, url),
        url,
        disposition?.value === undefined ? null : disposition.value,
      );
      return undefined;
    },
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["responseHeaders"],
  );

  browser.downloads.onCreated.addListener((item) => {
    void claim(item.id, withoutFragment(item.finalUrl));
  });

  browser.downloads.onChanged.addListener((delta) => {
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") {
      return;
    }
    void (async () => {
      const claimed = await begin(delta.id);
      if (claimed !== undefined) {
        await deliver(delta.id, claimed, saved);
      }
    })();
  });
}
