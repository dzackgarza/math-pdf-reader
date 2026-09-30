// Browser end-to-end proof of capture (#6): both built extensions, driven by Puppeteer
// (Chromium through --load-extension, Firefox through WebDriver BiDi webExtension.install),
// against the fixture site and the bucket server over a temporary store.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";
import { LONG_FRAME_PDF, pdfBytes, startFixtureSite } from "./fixture-site";
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
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
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

// Only launches: the suite holds the browser before anything else can fail, so its teardown
// closes it and Puppeteer removes the temporary profile. Firefox saves downloads to DOWNLOADS
// without asking.
function launch(engine: Engine, extension: string, downloads: string): Promise<Browser> {
  if (engine === "chrome") {
    return puppeteer.launch({
      browser: "chrome",
      executablePath: executable("chromium"),
      headless: true,
      enableExtensions: [extension],
      defaultViewport: viewport,
    });
  }
  return puppeteer.launch({
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
      "browser.download.dir": downloads,
      "browser.download.folderList": 2,
      "browser.download.useDownloadDir": true,
      "browser.download.always_ask_before_handling_new_types": false,
    },
  });
}

// Resolves once the extension's capture rules are in force, with its origin. Chrome saves
// downloads, among them the captured navigations, to DOWNLOADS.
async function extensionReady(
  engine: Engine,
  browser: Browser,
  extension: string,
  downloads: string,
): Promise<string> {
  if (engine === "chrome") {
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
    const session = await browser.target().createCDPSession();
    await session.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloads,
      eventsEnabled: true,
    });
    return `${workerUrl.protocol}//${workerUrl.host}`;
  }
  await browser.installExtension(extension);
  return `moz-extension://${FIREFOX_EXTENSION_UUID}`;
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
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  let bucket: Awaited<ReturnType<typeof startBucket>>;
  let browser: Browser;
  let extensionOrigin: string;
  // The folder the browser saves downloads to; a capture leaves nothing there.
  let downloads: string;
  // The extension build this engine runs; the suite removes it.
  let extension: string | null = null;
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

  // In Chrome a top-level PDF navigation becomes a download, so the tab stays on the page that
  // holds the link; in Firefox the tab passes through the capture page.
  const followLink = async (pagePath: string) => {
    await page.goto(`${site.origin}${pagePath}`);
    await page.click("a#pdf");
  };

  // The capture page tab Chrome's background opens for a failed download.
  const capturePageTab = async () => {
    const target = await browser.waitForTarget((candidate) =>
      candidate.url().startsWith(`${extensionOrigin}/capture.html?`),
    );
    const tab = await target.page();
    if (tab === null) {
      throw new Error("the capture page tab has no page");
    }
    return tab;
  };

  // Follows the PDF link on PAGEPATH, whose capture fails, and makes the tab showing the
  // failure the working tab. Firefox shows it in the tab the link was followed in; Chrome's
  // background opens a capture page tab for it, since the navigation became a download.
  const followLinkToFailure = async (pagePath: string) => {
    if (engine === "firefox") {
      await followLink(pagePath);
      await captureState(page, "failed");
      return;
    }
    const failureTab = capturePageTab();
    await followLink(pagePath);
    const tab = await failureTab;
    await captureState(tab, "failed");
    await page.close();
    page = tab;
    await page.setViewport(viewport);
  };

  // After a successful capture in the tab the link was followed in, the tab is back on the page
  // that holds the link. The location is read in the document: the tab passes through the
  // capture page, where Firefox reports no navigation.
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
    site = await startFixtureSite();
    bucket = await startBucket();
    extension = await buildExtension(engine, bucket.port);
    downloads = mkdtempSync(join(tmpdir(), "pdf-bucket-e2e-downloads-"));
    browser = await launch(engine, extension, downloads);
    extensionOrigin = await extensionReady(engine, browser, extension, downloads);
    page = await browser.newPage();
  }, 60_000);

  // Runs also when a test or the setup fails; closing the browser removes its profile.
  afterAll(async () => {
    site.stop();
    await bucket.stop();
    await browser.close();
    rmSync(downloads, { recursive: true, force: true });
    if (extension !== null) {
      rmSync(dirname(extension), { recursive: true, force: true });
    }
  });

  test("an arXiv /pdf/ URL without .pdf is captured with its link text, and the tab returns to the page that holds the link", async () => {
    const readerUrl = await captureInPlace("/abs/2401.00001");

    expect(readerUrl).toBe(`${bucket.origin}/read/2401.00001`);
    expect(bucket.files()).toEqual(["2401.00001.pdf"]);
    const stored = await provenance("2401.00001");
    expect(stored.pdf_url).toBe(`${site.origin}/pdf/2401.00001`);
    expect(stored.title_hint).toBe("Sphere packing in dimension 8 (PDF)");
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/pdf/2401.00001")));
  });

  test("the status page shows the connected bucket and the last capture, and the badge says ON", async () => {
    await openStatus("ready");
    await shotCapturePage("status-ready");

    expect(await text("#bucket-origin")).toBe(bucket.origin);
    expect(await text("#bucket-version")).toBe("1.0.0");
    expect(await text("#bucket-root")).toBe(bucket.root);
    expect(await text("#last-capture a")).toBe("Sphere packing in dimension 8 (PDF)");
    expect(await page.$eval("#last-capture a", (link) => link.getAttribute("href"))).toBe(
      `${bucket.origin}/read/2401.00001`,
    );
    expect(await badge()).toBe("ON");
  });

  test("Send tabs stores the PDF a tab's page names and closes that tab; a tab whose page names none stays and is listed", async () => {
    const captures = await subscribeToCaptures(bucket.origin);
    const abstract = await browser.newPage();
    await abstract.goto(`${site.origin}/open/abs/2402.00002`);
    const noPdf = await browser.newPage();
    await noPdf.goto(`${site.origin}/teaching.html`);
    await openStatus("ready");

    await page.$eval("#send-tabs", (button) => {
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    });
    await page.waitForSelector('#tabs[data-state="done"]');

    expect(await captures.next()).toBe(`${bucket.origin}/read/2402.00002`);
    const stored = await provenance("2402.00002");
    expect(stored.pdf_url).toBe(`${site.origin}/open/pdf/2402.00002`);
    expect(stored.title_hint).toBe("Even unimodular lattices");
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/open/pdf/2402.00002")));
    while (!(await tabGone(abstract))) {
      await Bun.sleep(50);
    }
    expect(await tabGone(noPdf)).toBe(false);
    expect(await text(`#not-sent li[data-url="${site.origin}/teaching.html"]`)).toContain(
      "names no PDF",
    );
    // WebDriver BiDi cannot activate a moz-extension tab; the extension API can, in both browsers.
    const tabs = engine === "chrome" ? "chrome.tabs" : "browser.tabs";
    await page.evaluate(
      `${tabs}.getCurrent().then((tab) => ${tabs}.update(tab.id, { active: true }))`,
    );
    await shotCapturePage("status-sent-tabs");
    await noPdf.close();
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
    // Chrome closes a tab opened only for a download before its page can be attached, so the
    // tab count is watched there.
    const tabsBefore = (await browser.pages()).length;
    const opened = engine === "chrome" ? undefined : openedTab();
    await page.click("a#pdf");
    expect(await captures.next()).toBe(`${bucket.origin}/read/survey`);
    if (opened === undefined) {
      while ((await browser.pages()).length !== tabsBefore) {
        await Bun.sleep(50);
      }
    } else {
      const tab = await opened;
      while (!(await tabGone(tab))) {
        await Bun.sleep(50);
      }
    }

    expect(page.url()).toBe(`${site.origin}/reading-list.html`);
    const stored = await provenance("survey");
    expect(stored.title_hint).toBe("A survey of lattices");
  });

  test("a .pdf URL is captured once; navigating to it again opens the existing item", async () => {
    expect(await captureInPlace("/teaching.html")).toBe(`${bucket.origin}/read/lecture-notes`);
    const stored = await provenance("lecture-notes");
    expect(stored.title_hint).toBe("Lecture notes on lattices");
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/notes/lecture-notes.pdf")));
    const storedBytes = sha256(readFileSync(join(bucket.root, "lecture-notes.pdf")));

    expect(await captureInPlace("/teaching.html")).toBe(`${bucket.origin}/read/lecture-notes`);
    expect(bucket.files()).toEqual([
      "2401.00001.pdf",
      "2402.00002.pdf",
      "lecture-notes.pdf",
      "survey.pdf",
    ]);
    expect(sha256(readFileSync(join(bucket.root, "lecture-notes.pdf")))).toBe(storedBytes);
  });

  test("a Content-Disposition download is captured under its declared filename", async () => {
    expect(await captureInPlace("/downloads.html")).toBe(`${bucket.origin}/read/problem-set`);
    expect(bucket.files()).toContain("problem-set.pdf");
    const stored = await provenance("problem-set");
    expect(stored.pdf_url).toBe(`${site.origin}/download?id=problem-set`);
    expect(stored.title_hint).toBe("Problem set 3");
  });

  // A publisher's "Download PDF" button is a link with the `download` attribute, which starts a
  // download, not a navigation.
  test("a PDF link with the download attribute is captured, and no download is left", async () => {
    const captures = await subscribeToCaptures(bucket.origin);
    await followLink("/article.html");
    expect(await captures.next()).toBe(`${bucket.origin}/read/offprint`);
    const stored = await provenance("offprint");
    expect(stored.pdf_url).toBe(`${site.origin}/content/pdf/10.5555/offprint.pdf`);
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/content/pdf/10.5555/offprint.pdf")));
    while (readdirSync(downloads).length > 0) {
      await Bun.sleep(50);
    }
  });

  test("a sub-frame large enough to read in is captured", async () => {
    await page.goto(`${site.origin}/frame-large.html`);
    // Chromium replaces the iframe's frame when it commits the capture page, so a handle to the
    // frame that still shows the PDF URL detaches; Firefox keeps one frame and reports no URL
    // change into it.
    const frame = await page.waitForFrame(
      (candidate) =>
        candidate.parentFrame() === page.mainFrame() &&
        (engine === "firefox" || candidate.url().startsWith(extensionOrigin)),
    );
    await captureState(frame, "stored");
    await shot("large-frame");

    const stored = await provenance("chapter");
    expect(stored.pdf_url).toBe(`${site.origin}/frames/chapter.pdf`);
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/frames/chapter.pdf")));
  });

  // The capture page is web-accessible, so a web page can frame it with any PDF URL. Only a
  // frame the extension itself sent there gets its PDF captured.
  test("a web page that frames the capture page with a PDF URL gets a failure and no capture", async () => {
    const before = bucket.files();
    const pdfPath = "/private/statement.pdf";
    await page.goto(`${site.origin}/teaching.html`);
    await page.evaluate(`{
      const frame = document.createElement("iframe");
      frame.src = ${JSON.stringify(`${extensionOrigin}/capture.html?${site.origin}${pdfPath}`)};
      frame.style = "width: 1000px; height: 700px";
      document.body.append(frame);
    }`);
    const frame = await page.waitForFrame(
      (candidate) =>
        candidate.parentFrame() === page.mainFrame() &&
        (engine === "firefox" || candidate.url().startsWith(extensionOrigin)),
    );
    await captureState(frame, "failed");

    expect(served()).not.toContain(`GET ${pdfPath}`);
    expect(bucket.files()).toEqual(before);
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

  test("a DOI link that redirects to the PDF is captured at its final PDF URL with its link text", async () => {
    expect(await captureInPlace("/citation.html")).toBe(`${bucket.origin}/read/redirected`);
    const stored = await provenance("redirected");
    expect(stored.pdf_url).toBe(`${site.origin}/articles/redirected.pdf`);
    expect(stored.title_hint).toBe("Full text via DOI");
  });

  test("a PDF link with a fragment is captured at its final PDF URL with its link text", async () => {
    expect(await captureInPlace("/fragment.html")).toBe(`${bucket.origin}/read/fragment`);
    const stored = await provenance("fragment");
    expect(stored.pdf_url).toBe(`${site.origin}/notes/fragment.pdf`);
    expect(stored.title_hint).toBe("Chapter two, page 2");
  });

  test("a PDF cited in a ChatGPT answer is captured with its file name, not the citation's site label or the chat's title", async () => {
    expect(await captureInPlace("/answer.html")).toBe(`${bucket.origin}/read/cited`);
    const stored = await provenance("cited");
    expect(stored.pdf_url).toBe(`${site.origin}/notes/cited.pdf`);
    expect(stored.title_hint).toBe("cited.pdf");
  });

  test("a PDF URL whose file name holds a Latin-1 escape is captured under that name", async () => {
    await captureInPlace("/latin1.html");
    expect(bucket.files()).toContain("caf%E9.pdf");
    const stored = await provenance("caf%E9");
    expect(stored.pdf_url).toBe(`${site.origin}/notes/caf%E9.pdf`);
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/notes/caf%E9.pdf")));
  });

  test("a gzip-encoded PDF is stored as the decoded PDF", async () => {
    expect(await captureInPlace("/compressed.html")).toBe(`${bucket.origin}/read/compressed`);
    const stored = await provenance("compressed");
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/notes/compressed.pdf")));
  });

  // Firefox keeps the navigation's own response; Chrome saves it as a download, which the
  // bucket reads and the extension then removes.
  test("a single-use PDF URL is captured from the browser's one request", async () => {
    const fetches = () => site.requests.filter((request) => request.path === "/once/ticket.pdf");
    expect(await captureInPlace("/ticket.html")).toBe(`${bucket.origin}/read/ticket`);
    const stored = await provenance("ticket");
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/once/ticket.pdf")));
    expect(fetches().length).toBe(1);
    while (readdirSync(downloads).length > 0) {
      await Bun.sleep(50);
    }
  });

  // Chrome stops a service worker whose fetch() response takes more than 30 s, and a slow
  // store can hold the bucket's answer past that. Here the post is held until the worker is
  // stopped. Only the extension removes a download, and only once the bucket answers that it
  // holds the PDF, so the emptied downloads folder shows that a later worker delivered it.
  test.if(engine === "chrome")(
    "a download whose worker stops before the bucket answers is captured by the next worker",
    async () => {
      // A page load is a response the worker listens for, so a worker is running after it.
      await page.goto(`${site.origin}/held.html`);
      const target = await browser.waitForTarget(
        (candidate) => candidate.type() === "service_worker",
      );
      const worker = await target.worker();
      if (worker === null) {
        throw new Error("the extension service worker target has no worker");
      }
      const posted = new Promise<void>((resolve) => {
        worker.client.once("Fetch.requestPaused", () => resolve());
      });
      await worker.client.send("Fetch.enable", {
        patterns: [{ urlPattern: "*/capture-download", requestStage: "Request" }],
      });
      await page.click("a#pdf");
      await posted;
      await worker.close();

      // A followed PDF link starts the next worker.
      await followLink("/teaching.html");
      while (!bucket.files().includes("held.pdf")) {
        await Bun.sleep(50);
      }
      while (readdirSync(downloads).length > 0) {
        await Bun.sleep(50);
      }
      const stored = await provenance("held");
      expect(stored.pdf_url).toBe(`${site.origin}/notes/held.pdf`);
      expect(stored.original_sha256).toBe(sha256(pdfBytes("/notes/held.pdf")));
    },
  );

  // Every GET response invariant 4 counts as a PDF, beyond `application/pdf`: a generic or
  // missing type on a `.pdf` path, the legacy PDF type, and whitespace before the parameters.
  test.each([
    ["binary/octet-stream on a .pdf path", "/scan.html", "scan", "/objects/scan.pdf"],
    ["application/force-download on a .pdf path", "/handout.html", "handout", "/files/handout.pdf"],
    ["no Content-Type on a .pdf path", "/untyped.html", "untyped", "/files/untyped.pdf"],
    ["application/x-pdf", "/legacy.html", "legacy", "/papers/legacy"],
    ["application/pdf ;version=1.7", "/spaced.html", "spaced", "/papers/spaced"],
  ])("a PDF served as %s is captured", async (_served, pagePath, key, pdfPath) => {
    expect(await captureInPlace(pagePath)).toBe(`${bucket.origin}/read/${key}`);
    const stored = await provenance(key);
    expect(stored.pdf_url).toBe(`${site.origin}${pdfPath}`);
    expect(stored.original_sha256).toBe(sha256(pdfBytes(pdfPath)));
  });

  // Firefox keeps its start page in the tab's session history, so the tab holds an entry
  // before the PDF's; the tab was still opened for the PDF alone. In Chrome a top-level PDF
  // becomes a download and the tab never leaves its page.
  test.if(engine === "firefox")(
    "a PDF URL entered in a tab showing the browser's start page is captured, and that tab closes",
    async () => {
      // The site sets its session cookie on its pages; its PDFs refuse requests without it.
      await page.goto(`${site.origin}/teaching.html`);
      const captures = await subscribeToCaptures(bucket.origin);
      const tab = await browser.newPage();
      await tab.goto("about:home");
      await tab.goto(`${site.origin}/notes/typed.pdf`);
      expect(await captures.next()).toBe(`${bucket.origin}/read/typed`);
      while (!(await tabGone(tab))) {
        await Bun.sleep(50);
      }
    },
  );

  test("two sub-frames below the minimum frame size are both handed back to the browser's viewer", async () => {
    const before = bucket.files();
    await page.goto(`${site.origin}/frames-small-pair.html`);
    await Bun.sleep(SETTLE_MS);

    const frames = page.frames().map((frame) => frame.url());
    expect(frames).toContain(`${site.origin}/frames/preview.pdf`);
    expect(frames).toContain(`${site.origin}/frames/appendix.pdf`);
    expect(bucket.files()).toEqual(before);
  });

  test("a sub-frame below the minimum frame size is handed back even when its PDF URL is several KB long", async () => {
    const before = bucket.files();
    await page.goto(`${site.origin}/frame-small-signed.html`);
    await Bun.sleep(SETTLE_MS);

    const frames = page.frames().map((frame) => frame.url());
    expect(frames).toContain(`${site.origin}${LONG_FRAME_PDF}`);
    expect(bucket.files()).toEqual(before);
  });

  test("with the bucket stopped, the capture page shows the failure and opens the PDF natively on request", async () => {
    const before = bucket.files();
    const pdfPath = "/notes/lecture-notes.pdf";
    const fetches = () => site.requests.filter((request) => request.path === pdfPath).length;
    await bucket.stop();

    await followLinkToFailure("/teaching.html");
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

  // Firefox keeps the tab the link opened; Chrome closes it, as it does for any tab opened only
  // for a download, and the background opens a capture page tab.
  test("with the bucket stopped, a PDF link that opens a new tab leaves a tab with the failure", async () => {
    await page.goto(`${site.origin}/reading-list.html`);
    const opened = engine === "chrome" ? capturePageTab() : openedTab();
    await page.click("a#pdf");
    const tab = await opened;
    await captureState(tab, "failed");
    await Bun.sleep(SETTLE_MS);

    expect(await tabGone(tab)).toBe(false);
    await tab.close();
  });

  test("with another service answering on the bucket's port, the badge shows ! and a capture reports the foreign answer", async () => {
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: bucket.port,
      fetch: () =>
        new Response("<!doctype html><title>Another service</title>", {
          headers: { "Content-Type": "text/html" },
        }),
    });
    try {
      await openStatus("unreachable");
      expect(await text("#connection-details")).toContain("not a PDF Bucket status report");
      expect(await badge()).toBe("!");

      // The lecture notes are exempted in this tab since the native open above.
      await followLinkToFailure("/abs/2401.00001");
      expect(await text("#details")).toContain("not with a capture response");
    } finally {
      await other.stop(true);
    }
  });
});
