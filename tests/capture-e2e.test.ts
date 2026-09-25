// Browser end-to-end proof of capture (#6): both built extensions, driven by Puppeteer
// (Chromium through --load-extension, Firefox through WebDriver BiDi webExtension.install),
// against the fixture site and the bucket server over a temporary store.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, {
  type Browser,
  type Frame,
  type Page,
  ProtocolError,
  type Target,
} from "puppeteer-core";
import { build } from "wxt";
import { z } from "zod";
import { OpenReaderSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { pdfCaptureRules } from "../src/extension/interception";
import { extensionDefine } from "../wxt.config";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";
import { lectureNotes, problemSet, startFixtureSite } from "./fixture-site";
import { listItems } from "./store";

type Engine = "chrome" | "firefox";

const repo = join(import.meta.dir, "..");
const config = loadAppConfig(CONFIG_PATH);
const screenshots = join(tmpdir(), "pdf-bucket-capture-e2e");
const viewport = { width: 1280, height: 900 };
const narrowViewport = { width: 400, height: 760 };
setDefaultTimeout(30_000);
// Long enough for an interception to redirect, fetch and post (well under a second here).
const SETTLE_MS = 1_500;

function executable(name: string): string {
  const path = Bun.which(name);
  if (path === null) {
    throw new Error(`${name} is not on PATH; the capture suite drives the real browser`);
  }
  return path;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startBucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-e2e-store-"));
  const app = await serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  return {
    root,
    port: Number(new URL(app.origin).port),
    origin: app.origin,
    files: () => readdirSync(root).sort(),
    stop: app.stop,
  };
}

async function buildExtension(engine: Engine, bucketPort: number): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), `pdf-bucket-e2e-${engine}-`));
  const server = { host: "127.0.0.1", port: bucketPort };
  await build({
    root: repo,
    browser: engine,
    mode: "production",
    outDir,
    vite: () => ({ define: extensionDefine({ ...config, server }) }),
  });
  return join(outDir, engine === "chrome" ? "chrome-mv3" : "firefox-mv2");
}

// Firefox gives each installed extension a random internal UUID for its moz-extension://
// origin; this pref pins it so the suite can open the extension's own pages.
const FIREFOX_EXTENSION_UUID = "5d1c2a8e-3f47-4b6e-9a0d-7c41e2b9f613";

type Launched = { browser: Browser; extensionOrigin: string };

async function launch(engine: Engine, extension: string): Promise<Launched> {
  if (engine === "chrome") {
    const browser = await puppeteer.launch({
      browser: "chrome",
      executablePath: executable("chromium"),
      headless: true,
      enableExtensions: [extension],
      defaultViewport: viewport,
    });
    // The service worker registers its rules asynchronously after install; navigating
    // before that would reach the browser's own viewer.
    const target = await browser.waitForTarget(
      (candidate) => candidate.type() === "service_worker",
    );
    const worker = await target.worker();
    if (worker === null) {
      throw new Error("the extension service worker target has no worker");
    }
    const registered = async () =>
      z
        .number()
        .parse(
          await worker.evaluate(
            "chrome.declarativeNetRequest.getDynamicRules().then((rules) => rules.length)",
          ),
        );
    while ((await registered()) < pdfCaptureRules("", "").length) {
      await Bun.sleep(50);
    }
    // `URL.origin` is "null" for the non-special chrome-extension: scheme.
    const workerUrl = new URL(target.url());
    return { browser, extensionOrigin: `${workerUrl.protocol}//${workerUrl.host}` };
  }
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: executable("firefox"),
    headless: true,
    defaultViewport: viewport,
    // The capture page is a moz-extension (privileged) document; BiDi scripts it only then.
    args: ["-remote-allow-system-access"],
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({
        "pdf-bucket@dzackgarza.com": FIREFOX_EXTENSION_UUID,
      }),
    },
  });
  await browser.installExtension(extension);
  return { browser, extensionOrigin: `moz-extension://${FIREFOX_EXTENSION_UUID}` };
}

// The bucket announces every capture, new or existing, on the event stream the desktop
// window follows. Subscribing resolves once the bucket has registered the subscriber, so an
// announcement cannot be missed by a capture started afterwards.
async function subscribeToCaptures(bucketOrigin: string) {
  const response = await fetch(`${bucketOrigin}/api/events`);
  if (response.body === null) {
    throw new Error("the bucket's event stream has no body");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  return {
    // The reader URL of the next announced capture.
    async next(): Promise<string> {
      let received = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("the bucket's event stream ended before a capture was announced");
        }
        received += chunk.value;
        const announced = /event: open-reader\ndata: (.+)\n/.exec(received)?.[1];
        if (announced !== undefined) {
          await reader.cancel();
          return OpenReaderSchema.parse(JSON.parse(announced)).reader_url;
        }
      }
    },
  };
}

async function captureState(frame: Frame | Page, state: "stored" | "failed"): Promise<void> {
  await frame.waitForSelector(`main#capture[data-state="${state}"]`);
}

// Firefox reports no navigation events for moz-extension documents, so URL changes are
// awaited by polling; the case timeout bounds the wait.
async function urlBecomes(page: Page, url: string): Promise<void> {
  while (page.url() !== url) {
    await Bun.sleep(50);
  }
}

describe.each<Engine>(["chrome", "firefox"])("capture in %s", (engine) => {
  const site = startFixtureSite();
  let bucket: Awaited<ReturnType<typeof startBucket>>;
  let browser: Browser;
  let extensionOrigin: string;
  let page: Page;

  const shot = async (name: string) => {
    await page.screenshot({ path: join(screenshots, `${engine}-${name}.png`) });
  };
  // WebDriver BiDi refuses to screenshot or resize privileged (moz-extension) top-level
  // documents, so in Firefox the capture page photographs its own tab through the extension
  // API, at the default viewport only.
  const shotCapturePage = async (name: string) => {
    if (engine === "chrome") {
      await shot(name);
      await page.setViewport(narrowViewport);
      await shot(`${name}-narrow`);
      await page.setViewport(viewport);
      return;
    }
    const dataUrl = z
      .string()
      .startsWith("data:image/png;base64,")
      .parse(await page.evaluate("browser.tabs.captureVisibleTab()"));
    const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
    await Bun.write(join(screenshots, `${engine}-${name}.png`), png);
  };

  // Chromium swaps the tab's main frame when it commits the extension page, so the wait for
  // the capture state starts after that commit. Firefox reports no navigation into
  // moz-extension documents and keeps the frame.
  const followLink = async (pagePath: string) => {
    await page.goto(`${site.origin}${pagePath}`);
    if (engine === "chrome") {
      await Promise.all([page.waitForNavigation(), page.click("a#pdf")]);
      return;
    }
    await page.click("a#pdf");
  };

  // After a successful capture in the tab the link was followed in, the tab is back on the
  // linking page. The location is read in the document: the tab passes through the capture
  // page, where Firefox reports no navigation.
  const captureInPlace = async (pagePath: string) => {
    const captures = await subscribeToCaptures(bucket.origin);
    await followLink(pagePath);
    const readerUrl = await captures.next();
    await page.waitForFunction(`location.href === ${JSON.stringify(`${site.origin}${pagePath}`)}`);
    return readerUrl;
  };
  // The tab a target=_blank link opens.
  const openedTab = () =>
    new Promise<Page>((resolve) => {
      const opened = (target: Target) => {
        if (target.type() !== "page") {
          return;
        }
        browser.off("targetcreated", opened);
        void target.page().then((tab) => {
          if (tab === null) {
            throw new Error("the tab the link opened has no page");
          }
          resolve(tab);
        });
      };
      browser.on("targetcreated", opened);
    });
  // Whether a tab is gone. Chrome reports the closed tab (`isClosed()`); its Page keeps the
  // frame Chromium swapped out for the extension page, so nothing can be evaluated there even
  // while the tab is open. Firefox's WebDriver BiDi loses track of a tab that navigated into a
  // moz-extension document, so `isClosed()` stays false after it closes; the browser itself
  // then refuses to evaluate in it.
  const tabGone = async (tab: Page) => {
    if (engine === "chrome" || tab.isClosed()) {
      return tab.isClosed();
    }
    return tab.evaluate("1").then(
      () => false,
      (error: unknown) => {
        if (error instanceof ProtocolError) {
          return true;
        }
        throw error;
      },
    );
  };

  // The toolbar popup, opened as a tab: the extension's status page. WebDriver BiDi cannot
  // navigate a Firefox tab into a moz-extension document, and after a page script does it,
  // Puppeteer's recorded URL stays stale while the document itself stays scriptable. So in
  // Firefox a page script goes to the web-accessible capture page (given no PDF URL, it
  // captures nothing), then within the extension's origin, and the document's own
  // location is polled.
  const documentUrl = async () => z.string().parse(await page.evaluate("location.href"));
  const scriptNavigate = async (url: string) => {
    await page.evaluate(`location.assign(${JSON.stringify(url)})`);
    while ((await documentUrl()) !== url) {
      await Bun.sleep(50);
    }
  };
  const openStatus = async (state: "ready" | "unreachable") => {
    const status = `${extensionOrigin}/popup.html`;
    if (engine === "chrome") {
      await page.goto(status);
    } else {
      if (!(await documentUrl()).startsWith(extensionOrigin)) {
        await scriptNavigate(`${extensionOrigin}/capture.html`);
      }
      await scriptNavigate(status);
    }
    await page.waitForSelector(`#connection[data-state="${state}"]`);
  };
  // Firefox refuses synthesized input in privileged (moz-extension) documents; a DOM click
  // flips the checkbox and fires its change event in both browsers.
  const flipCaptureSwitch = async () => {
    await page.$eval("#capture-enabled", (box) => {
      if (box instanceof HTMLInputElement) {
        box.click();
      }
    });
  };
  const text = async (selector: string) =>
    z.string().parse(await page.$eval(selector, (node) => node.textContent));
  const badge = async () =>
    z
      .string()
      .parse(
        await page.evaluate(
          engine === "chrome"
            ? "chrome.action.getBadgeText({})"
            : "browser.browserAction.getBadgeText({})",
        ),
      );
  const badgeBecomes = async (expected: string) => {
    while ((await badge()) !== expected) {
      await Bun.sleep(50);
    }
  };

  const provenance = async (key: string) => (await listItems(bucket.root, [key]))[0]?.provenance;
  const served = () => site.requests.map((request) => `${request.method} ${request.path}`);

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    bucket = await startBucket();
    ({ browser, extensionOrigin } = await launch(
      engine,
      await buildExtension(engine, bucket.port),
    ));
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    await bucket.stop();
    site.stop();
  });

  test("an arXiv /pdf/ URL without .pdf is captured with the linking page and link text, and the tab returns to that page", async () => {
    const readerUrl = await captureInPlace("/abs/2401.00001");

    expect(readerUrl).toBe(`${bucket.origin}/read/2401.00001`);
    expect(bucket.files()).toEqual(["2401.00001.pdf"]);
    const stored = await provenance("2401.00001");
    expect(stored.pdf_url).toBe(`${site.origin}/pdf/2401.00001`);
    expect(stored.source_url).toBe(`${site.origin}/abs/2401.00001`);
    expect(stored.title_hint).toBe("Sphere packing in dimension 8 (PDF)");
    expect(stored.original_sha256).toBe(sha256(problemSet));
  });

  test("the status page shows the connected bucket and the last capture, and the badge says ON", async () => {
    await openStatus("ready");
    await shotCapturePage("status-ready");

    expect(await text("#bucket-origin")).toBe(bucket.origin);
    expect(await text("#bucket-version")).toBe("0.1.0");
    expect(await text("#bucket-root")).toBe(bucket.root);
    expect(await text("#last-capture a")).toBe("Sphere packing in dimension 8 (PDF)");
    expect(await page.$eval("#last-capture a", (link) => link.getAttribute("href"))).toBe(
      `${bucket.origin}/read/2401.00001`,
    );
    expect(await badge()).toBe("ON");
  });

  test("with capture turned off a PDF link opens in the browser; turned back on, it is captured", async () => {
    await openStatus("ready");
    await flipCaptureSwitch();
    await badgeBecomes("OFF");
    await shotCapturePage("status-off");

    // An intercepted navigation would end on the capture page, not on the PDF's own URL.
    const pdfUrl = `${site.origin}/pdf/2401.00001`;
    const fetches = () => site.requests.filter((request) => request.path === "/pdf/2401.00001");
    const before = fetches().length;
    await followLink("/abs/2401.00001");
    await Bun.sleep(SETTLE_MS);
    expect(page.url()).toBe(pdfUrl);
    expect(fetches().length).toBe(before + 1);

    await openStatus("ready");
    const checked = await page.$eval("#capture-enabled", (box) =>
      box instanceof HTMLInputElement ? box.checked : null,
    );
    expect(checked).toBe(false);
    await flipCaptureSwitch();
    await badgeBecomes("ON");
    expect(await captureInPlace("/abs/2401.00001")).toBe(`${bucket.origin}/read/2401.00001`);
  });

  test("a PDF link that opens a new tab is captured, and that tab closes", async () => {
    await page.goto(`${site.origin}/reading-list.html`);
    const captures = await subscribeToCaptures(bucket.origin);
    const opened = openedTab();
    await page.click("a#pdf");
    const tab = await opened;
    expect(await captures.next()).toBe(`${bucket.origin}/read/survey`);
    while (!(await tabGone(tab))) {
      await Bun.sleep(50);
    }

    expect(page.url()).toBe(`${site.origin}/reading-list.html`);
    const stored = await provenance("survey");
    expect(stored.source_url).toBe(`${site.origin}/reading-list.html`);
    expect(stored.title_hint).toBe("A survey of lattices");
  });

  test("a .pdf URL is captured once; navigating to it again opens the existing item", async () => {
    expect(await captureInPlace("/teaching.html")).toBe(`${bucket.origin}/read/lecture-notes`);
    const stored = await provenance("lecture-notes");
    expect(stored.source_url).toBe(`${site.origin}/teaching.html`);
    expect(stored.title_hint).toBe("Lecture notes on lattices");
    expect(stored.original_sha256).toBe(sha256(lectureNotes));
    const storedBytes = sha256(readFileSync(join(bucket.root, "lecture-notes.pdf")));

    expect(await captureInPlace("/teaching.html")).toBe(`${bucket.origin}/read/lecture-notes`);
    expect(bucket.files()).toEqual(["2401.00001.pdf", "lecture-notes.pdf", "survey.pdf"]);
    expect(sha256(readFileSync(join(bucket.root, "lecture-notes.pdf")))).toBe(storedBytes);
  });

  test("a Content-Disposition download is captured under its declared filename", async () => {
    expect(await captureInPlace("/downloads.html")).toBe(`${bucket.origin}/read/problem-set`);
    expect(bucket.files()).toContain("problem-set.pdf");
    const stored = await provenance("problem-set");
    expect(stored.pdf_url).toBe(`${site.origin}/download?id=problem-set`);
    expect(stored.source_url).toBe(`${site.origin}/downloads.html`);
    expect(stored.title_hint).toBe("Problem set 3");
  });

  test("a sub-frame large enough to read in is captured", async () => {
    await page.goto(`${site.origin}/frame-large.html`);
    const frame = await page.waitForFrame(
      (candidate) => candidate.parentFrame() === page.mainFrame(),
    );
    await captureState(frame, "stored");
    await shot("large-frame");

    const stored = await provenance("chapter");
    expect(stored.pdf_url).toBe(`${site.origin}/frames/chapter.pdf`);
    // No link was followed to the framed PDF, so no linking page is recorded.
    expect(stored.source_url).toBeNull();
    expect(stored.original_sha256).toBe(sha256(lectureNotes));
  });

  test("an inline <embed> of a PDF is left to the browser", async () => {
    const before = bucket.files();
    await page.goto(`${site.origin}/embed.html`);
    await Bun.sleep(SETTLE_MS);

    expect(served()).toContain("GET /embedded/figure.pdf");
    expect(page.url()).toBe(`${site.origin}/embed.html`);
    expect(bucket.files()).toEqual(before);
  });

  test("a sub-frame below the minimum frame size is handed back to the browser's viewer", async () => {
    const before = bucket.files();
    await page.goto(`${site.origin}/frame-small.html`);
    await Bun.sleep(SETTLE_MS);

    // The frame shows the PDF at its own URL; a captured frame would show the capture page.
    // (Chromium's own PDF viewer adds a nested frame of its own.)
    const frames = page.frames().map((frame) => frame.url());
    expect(frames).toContain(`${site.origin}/frames/preview.pdf`);
    expect(bucket.files()).toEqual(before);
  });

  test("a PDF returned by a POST form is left to the browser", async () => {
    const before = bucket.files();
    await page.goto(`${site.origin}/form.html`);
    await page.click("#generate");
    await urlBecomes(page, `${site.origin}/generate`);
    await Bun.sleep(SETTLE_MS);

    expect(served()).toContain("POST /generate");
    // A captured POST response would be fetched again, by GET, from the capture page.
    expect(served()).not.toContain("GET /generate");
    expect(bucket.files()).toEqual(before);
  });

  test("the bucket's own PDF URLs are not intercepted", async () => {
    const before = bucket.files();
    const own = `${bucket.origin}/pdf/lecture-notes.pdf`;
    await page.goto(own);
    await Bun.sleep(SETTLE_MS);
    expect(page.url()).toBe(own);
    expect(bucket.files()).toEqual(before);
  });

  test("with the bucket stopped, the capture page shows the failure and opens the PDF natively on request", async () => {
    const before = bucket.files();
    const pdfPath = "/notes/lecture-notes.pdf";
    const fetches = () => site.requests.filter((request) => request.path === pdfPath).length;
    await bucket.stop();

    await followLink("/teaching.html");
    await captureState(page, "failed");
    await shotCapturePage("bucket-down");

    const beforeNativeOpen = fetches();
    await page.$eval("#open-natively", (link) => {
      if (link instanceof HTMLAnchorElement) {
        link.click();
      }
    });
    await urlBecomes(page, `${site.origin}${pdfPath}`);
    await Bun.sleep(SETTLE_MS);
    await shot("opened-natively");
    // One native load; an intercepted load would add the capture page's own fetch.
    expect(fetches()).toBe(beforeNativeOpen + 1);
    expect(bucket.files()).toEqual(before);
  });

  test("with the bucket stopped, the status page says it is unreachable and the badge shows !", async () => {
    await openStatus("unreachable");
    await shotCapturePage("status-unreachable");

    expect(await text("#bucket-origin")).toBe(bucket.origin);
    expect(await badge()).toBe("!");
  });

  test("with the bucket stopped, a PDF link that opens a new tab keeps that tab with the failure", async () => {
    await page.goto(`${site.origin}/reading-list.html`);
    const opened = openedTab();
    await page.click("a#pdf");
    const tab = await opened;
    await captureState(tab, "failed");
    await Bun.sleep(SETTLE_MS);

    expect(await tabGone(tab)).toBe(false);
    await tab.close();
  });
});
