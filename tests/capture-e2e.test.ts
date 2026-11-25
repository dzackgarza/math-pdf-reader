import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { SCREENSHOT_ROOT } from "./preload";
import { listItems } from "./store";

type Engine = "chrome" | "firefox";

const repo = join(import.meta.dir, "..");
const config = loadAppConfig(CONFIG_PATH);
const screenshots = join(SCREENSHOT_ROOT, "pdf-bucket-capture-e2e");
const viewport = { width: 1280, height: 900 };
const narrowViewport = { width: 400, height: 760 };
setDefaultTimeout(30_000);
const SETTLE_MS = 1_500;

function executable(name: string): string {
  const path = Bun.which(name);
  if (path === null) {
    throw new Error(
      `${name} is not on PATH; the capture suite drives the real browser`,
    );
  }
  return path;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startBucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-e2e-store-"));
  const extensions = mkdtempSync(join(tmpdir(), "pdf-bucket-e2e-extensions-"));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    extensions,
  });
  return {
    root,
    extensions,
    provision: (version: string) => {
      for (const build of ["chrome-mv3", "firefox-mv2"]) {
        mkdirSync(join(extensions, build), { recursive: true });
        writeFileSync(
          join(extensions, build, "manifest.json"),
          JSON.stringify({ version }),
        );
      }
    },
    unprovision: () => {
      rmSync(extensions, { recursive: true, force: true });
      mkdirSync(extensions);
    },
    port: Number(new URL(app.origin).port),
    origin: app.origin,
    files: () =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".pdf"))
        .sort(),
    stop: app.stop,
  };
}

async function buildExtension(
  engine: Engine,
  bucketPort: number,
): Promise<string> {
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

const FIREFOX_EXTENSION_UUID = "5d1c2a8e-3f47-4b6e-9a0d-7c41e2b9f613";

function launch(
  engine: Engine,
  extension: string,
  downloads: string,
): Promise<Browser> {
  if (engine === "chrome") {
    return puppeteer.launch({
      browser: "chrome",
      executablePath: executable("chromium"),
      headless: true,
      enableExtensions: [extension],
      defaultViewport: viewport,
      dumpio: true,
    });
  }
  return puppeteer.launch({
    browser: "firefox",
    executablePath: executable("firefox"),
    headless: true,
    defaultViewport: viewport,
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
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

async function extensionReady(
  engine: Engine,
  browser: Browser,
  extension: string,
  downloads: string,
): Promise<string> {
  if (engine === "chrome") {
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
    while ((await registered()) < pdfCaptureRules("").length) {
      await Bun.sleep(50);
    }
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

async function subscribeToCaptures(bucketOrigin: string) {
  const response = await fetch(`${bucketOrigin}/api/events`);
  if (response.body === null) {
    throw new Error("the bucket's event stream has no body");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  return {
    async next(): Promise<string> {
      let received = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(
            "the bucket's event stream ended before a capture was announced",
          );
        }
        received += chunk.value;
        const announced = /event: open-reader\ndata: (.+)\n/.exec(
          received,
        )?.[1];
        if (announced !== undefined) {
          await reader.cancel();
          return OpenReaderSchema.parse(JSON.parse(announced)).reader_url;
        }
      }
    },
  };
}

async function captureState(
  frame: Frame | Page,
  state: "stored" | "failed",
): Promise<void> {
  await frame.waitForSelector(`main#capture[data-state="${state}"]`);
}

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
  let downloads: string;
  let extension: string | null = null;
  let page: Page;

  const shot = async (name: string) => {
    await page.screenshot({ path: join(screenshots, `${engine}-${name}.png`) });
  };
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
    const png = Buffer.from(
      dataUrl.slice("data:image/png;base64,".length),
      "base64",
    );
    await Bun.write(join(screenshots, `${engine}-${name}.png`), png);
  };

  const followLink = async (pagePath: string) => {
    await page.goto(`${site.origin}${pagePath}`);
    await page.click("a#pdf");
  };

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

  const captureInPlace = async (pagePath: string) => {
    const captures = await subscribeToCaptures(bucket.origin);
    await followLink(pagePath);
    const readerUrl = await captures.next();
    await page.waitForFunction(
      `location.href === ${JSON.stringify(`${site.origin}${pagePath}`)}`,
    );
    return readerUrl;
  };
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

  const documentUrl = async () =>
    z.string().parse(await page.evaluate("location.href"));
  const scriptNavigate = async (url: string) => {
    await page.evaluate(`location.assign(${JSON.stringify(url)})`);
    while ((await documentUrl()) !== url) {
      await Bun.sleep(50);
    }
  };
  const openStatus = async (
    state: "ready" | "unreachable" | "stale" | "checking",
  ) => {
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
  const toolbarTitle = async () =>
    z
      .string()
      .parse(
        await page.evaluate(
          engine === "chrome"
            ? "chrome.action.getTitle({})"
            : "browser.browserAction.getTitle({})",
        ),
      );
  const details = async () =>
    z
      .record(z.string(), z.string())
      .parse(
        await page.$$eval("#connection-details dt", (terms) =>
          Object.fromEntries(
            terms.map((term) => [
              term.textContent,
              term.nextElementSibling?.textContent,
            ]),
          ),
        ),
      );
  const statusPageReloadsChrome = async () => {
    const restarted = new Promise<void>((resolve) => {
      const created = (target: Target) => {
        if (target.type() === "service_worker") {
          browser.off("targetcreated", created);
          resolve();
        }
      };
      browser.on("targetcreated", created);
    });
    const opener = await browser.newPage();
    void opener.goto(`${extensionOrigin}/popup.html`).catch(() => undefined);
    await restarted;
    if (!opener.isClosed()) {
      await opener.close().catch(() => undefined);
    }
  };

  const provenance = async (key: string) =>
    (await listItems(bucket.root, [key]))[0]?.provenance;
  const served = () =>
    site.requests.map((request) => `${request.method} ${request.path}`);

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    site = await startFixtureSite();
    bucket = await startBucket();
    extension = await buildExtension(engine, bucket.port);
    downloads = mkdtempSync(join(tmpdir(), "pdf-bucket-e2e-downloads-"));
    browser = await launch(engine, extension, downloads);
    extensionOrigin = await extensionReady(
      engine,
      browser,
      extension,
      downloads,
    );
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    site.stop();
    await bucket.stop();
    await browser.close();
    rmSync(downloads, { recursive: true, force: true });
    rmSync(bucket.extensions, { recursive: true, force: true });
    if (extension !== null) {
      rmSync(dirname(extension), { recursive: true, force: true });
    }
  });

  test("an arXiv /pdf/ URL without .pdf is captured with its link text, and the tab returns to the page that holds the link", async () => {
    const readerUrl = await captureInPlace("/abs/2401.00001");

    expect(readerUrl).toBe(`${bucket.origin}/read/2401.00001`);
    expect(bucket.files()).toEqual(["2401.00001/2401.00001.pdf"]);
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
    expect(await text("#last-capture a")).toBe(
      "Sphere packing in dimension 8 (PDF)",
    );
    expect(
      await page.$eval("#last-capture a", (link) => link.getAttribute("href")),
    ).toBe(`${bucket.origin}/read/2401.00001`);
    expect(await badge()).toBe("ON");
  });

  test("the status page and the badge name Math PDF Reader, and the status page says no build of this extension is provisioned", async () => {
    await openStatus("ready");

    expect(await page.title()).toBe("Math PDF Reader");
    expect(await details()).toMatchObject({
      Address: bucket.origin,
      Provisioned:
        "none: Math PDF Reader offers no build of this extension, so it cannot replace this one when it changes",
    });
    expect(await toolbarTitle()).toBe(
      "Math PDF Reader: PDF links open in the app",
    );
  });

  test("a build other than the provisioned one shows OLD with its replacement and refuses a PDF link, which is stored once the provisioned build is the loaded one", async () => {
    const own = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(readFileSync(join(extension ?? "", "manifest.json"), "utf8")),
      ).version;
    bucket.provision("0.0.1");
    try {
      if (engine === "chrome") {
        await statusPageReloadsChrome();
      }
      await openStatus("stale");
      await shotCapturePage("status-stale");

      const stale = `Math PDF Reader was provisioned with version 0.0.1 of this extension, which is version ${own}; it captures nothing until it is replaced: `;
      const replacement =
        engine === "chrome"
          ? "Chromium loads this extension from another directory; load it unpacked from the installed app's extensions/chrome-mv3"
          : "Firefox installs it from Math PDF Reader at its next add-on update check, within a few minutes";
      expect(await details()).toEqual({
        Address: bucket.origin,
        "This build": own,
        Provisioned: "0.0.1",
        Replacement: replacement,
      });
      expect(await badge()).toBe("OLD");
      expect(await toolbarTitle()).toBe(`${stale}${replacement}`);

      const before = bucket.files();
      await followLinkToFailure("/abs/2401.00001");
      expect(await page.title()).toBe("Not saved · Math PDF Reader");
      expect(await text("#details")).toContain(`${stale}${replacement}`);
      expect(bucket.files()).toEqual(before);

      bucket.provision(own);
      expect(await captureInPlace("/abs/2401.00001")).toBe(
        `${bucket.origin}/read/2401.00001`,
      );
      expect(bucket.files()).toContain("2401.00001/2401.00001.pdf");
    } finally {
      bucket.unprovision();
    }
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
    expect(stored.original_sha256).toBe(
      sha256(pdfBytes("/open/pdf/2402.00002")),
    );
    while (!(await tabGone(abstract))) {
      await Bun.sleep(50);
    }
    expect(await tabGone(noPdf)).toBe(false);
    expect(
      await text(`#not-sent li[data-url="${site.origin}/teaching.html"]`),
    ).toContain("names no PDF");
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

    const pdfUrl = `${site.origin}/pdf/2401.00001`;
    const fetches = () =>
      site.requests.filter((request) => request.path === "/pdf/2401.00001");
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
    expect(await captureInPlace("/abs/2401.00001")).toBe(
      `${bucket.origin}/read/2401.00001`,
    );
  });

  test("a PDF link that opens a new tab is captured, and that tab closes", async () => {
    await page.goto(`${site.origin}/reading-list.html`);
    const captures = await subscribeToCaptures(bucket.origin);
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
    expect(await captureInPlace("/teaching.html")).toBe(
      `${bucket.origin}/read/lecture-notes`,
    );
    const stored = await provenance("lecture-notes");
    expect(stored.title_hint).toBe("Lecture notes on lattices");
    expect(stored.original_sha256).toBe(
      sha256(pdfBytes("/notes/lecture-notes.pdf")),
    );
    const storedBytes = sha256(
      readFileSync(join(bucket.root, "lecture-notes", "lecture-notes.pdf")),
    );

    expect(await captureInPlace("/teaching.html")).toBe(
      `${bucket.origin}/read/lecture-notes`,
    );
    expect(bucket.files()).toEqual([
      "2401.00001/2401.00001.pdf",
      "2402.00002/2402.00002.pdf",
      "lecture-notes/lecture-notes.pdf",
      "survey/survey.pdf",
    ]);
    expect(
      sha256(
        readFileSync(join(bucket.root, "lecture-notes", "lecture-notes.pdf")),
      ),
    ).toBe(storedBytes);
  });

  test("a Content-Disposition download is captured under its declared filename", async () => {
    expect(await captureInPlace("/downloads.html")).toBe(
      `${bucket.origin}/read/problem-set`,
    );
    expect(bucket.files()).toContain("problem-set/problem-set.pdf");
    const stored = await provenance("problem-set");
    expect(stored.pdf_url).toBe(`${site.origin}/download?id=problem-set`);
    expect(stored.title_hint).toBe("Problem set 3");
  });

  test("a PDF link with the download attribute is captured, and no download is left", async () => {
    const captures = await subscribeToCaptures(bucket.origin);
    await followLink("/article.html");
    expect(await captures.next()).toBe(`${bucket.origin}/read/offprint`);
    const stored = await provenance("offprint");
    expect(stored.pdf_url).toBe(
      `${site.origin}/content/pdf/10.5555/offprint.pdf`,
    );
    expect(stored.original_sha256).toBe(
      sha256(pdfBytes("/content/pdf/10.5555/offprint.pdf")),
    );
    while (readdirSync(downloads).length > 0) {
      await Bun.sleep(50);
    }
  });

  test("a sub-frame large enough to read in is captured", async () => {
    await page.goto(`${site.origin}/frame-large.html`);
    const frame = await page.waitForFrame(
      (candidate) =>
        candidate.parentFrame() === page.mainFrame() &&
        (engine === "firefox" || candidate.url().startsWith(extensionOrigin)),
    );
    await captureState(frame, "stored");
    await shot("large-frame");

    const stored = await provenance("chapter");
    expect(stored.pdf_url).toBe(`${site.origin}/frames/chapter.pdf`);
    expect(stored.original_sha256).toBe(
      sha256(pdfBytes("/frames/chapter.pdf")),
    );
  });

  test("a single-use PDF in a sub-frame is captured from the browser's one request", async () => {
    const pdfPath = "/once/framed-ticket.pdf";
    await page.goto(`${site.origin}/frame-ticket.html`);
    const frame = await page.waitForFrame(
      (candidate) =>
        candidate.parentFrame() === page.mainFrame() &&
        (engine === "firefox" || candidate.url().startsWith(extensionOrigin)),
    );
    await captureState(frame, "stored");

    const stored = await provenance("framed-ticket");
    expect(stored.pdf_url).toBe(`${site.origin}${pdfPath}`);
    expect(stored.original_sha256).toBe(sha256(pdfBytes(pdfPath)));
    expect(
      site.requests.filter((request) => request.path === pdfPath).length,
    ).toBe(1);
    while (readdirSync(downloads).length > 0) {
      await Bun.sleep(50);
    }
  });

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
    expect(await captureInPlace("/citation.html")).toBe(
      `${bucket.origin}/read/redirected`,
    );
    const stored = await provenance("redirected");
    expect(stored.pdf_url).toBe(`${site.origin}/articles/redirected.pdf`);
    expect(stored.title_hint).toBe("Full text via DOI");
  });

  test("a PDF link with a fragment is captured at its final PDF URL with its link text", async () => {
    expect(await captureInPlace("/fragment.html")).toBe(
      `${bucket.origin}/read/fragment`,
    );
    const stored = await provenance("fragment");
    expect(stored.pdf_url).toBe(`${site.origin}/notes/fragment.pdf`);
    expect(stored.title_hint).toBe("Chapter two, page 2");
  });

  test("a PDF cited in a ChatGPT answer is captured with its file name, not the citation's site label or the chat's title", async () => {
    expect(await captureInPlace("/answer.html")).toBe(
      `${bucket.origin}/read/cited`,
    );
    const stored = await provenance("cited");
    expect(stored.pdf_url).toBe(`${site.origin}/notes/cited.pdf`);
    expect(stored.title_hint).toBe("cited.pdf");
  });

  test("a PDF URL whose file name holds a Latin-1 escape is captured under that name", async () => {
    await captureInPlace("/latin1.html");
    expect(bucket.files()).toContain("caf%E9/caf%E9.pdf");
    const stored = await provenance("caf%E9");
    expect(stored.pdf_url).toBe(`${site.origin}/notes/caf%E9.pdf`);
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/notes/caf%E9.pdf")));
  });

  test("a gzip-encoded PDF is stored as the decoded PDF", async () => {
    expect(await captureInPlace("/compressed.html")).toBe(
      `${bucket.origin}/read/compressed`,
    );
    const stored = await provenance("compressed");
    expect(stored.original_sha256).toBe(
      sha256(pdfBytes("/notes/compressed.pdf")),
    );
  });

  test("a single-use PDF URL is captured from the browser's one request", async () => {
    const fetches = () =>
      site.requests.filter((request) => request.path === "/once/ticket.pdf");
    expect(await captureInPlace("/ticket.html")).toBe(
      `${bucket.origin}/read/ticket`,
    );
    const stored = await provenance("ticket");
    expect(stored.original_sha256).toBe(sha256(pdfBytes("/once/ticket.pdf")));
    expect(fetches().length).toBe(1);
    while (readdirSync(downloads).length > 0) {
      await Bun.sleep(50);
    }
  });

  test.if(engine === "chrome")(
    "a download whose worker stops before the bucket answers is captured by the next worker",
    async () => {
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
        patterns: [
          { urlPattern: "*/capture-download", requestStage: "Request" },
        ],
      });
      await page.click("a#pdf");
      await posted;
      await worker.close();

      await followLink("/teaching.html");
      while (!bucket.files().includes("held/held.pdf")) {
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

  test.each([
    [
      "binary/octet-stream on a .pdf path",
      "/scan.html",
      "scan",
      "/objects/scan.pdf",
    ],
    [
      "application/force-download on a .pdf path",
      "/handout.html",
      "handout",
      "/files/handout.pdf",
    ],
    [
      "no Content-Type on a .pdf path",
      "/untyped.html",
      "untyped",
      "/files/untyped.pdf",
    ],
    ["application/x-pdf", "/legacy.html", "legacy", "/papers/legacy"],
    [
      "application/pdf ;version=1.7",
      "/spaced.html",
      "spaced",
      "/papers/spaced",
    ],
  ])(
    "a PDF served as %s is captured",
    async (_served, pagePath, key, pdfPath) => {
      expect(await captureInPlace(pagePath)).toBe(
        `${bucket.origin}/read/${key}`,
      );
      const stored = await provenance(key);
      expect(stored.pdf_url).toBe(`${site.origin}${pdfPath}`);
      expect(stored.original_sha256).toBe(sha256(pdfBytes(pdfPath)));
    },
  );

  test.if(engine === "firefox")(
    "a PDF URL entered in a tab showing the browser's start page is captured, and that tab closes",
    async () => {
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
    const fetches = () =>
      site.requests.filter((request) => request.path === pdfPath).length;
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
    expect(fetches()).toBe(beforeNativeOpen + 1);
    expect(bucket.files()).toEqual(before);
  });

  test("with the bucket stopped, the status page says it is unreachable and the badge shows !", async () => {
    await openStatus("unreachable");
    await shotCapturePage("status-unreachable");

    expect(await text("#bucket-origin")).toBe(bucket.origin);
    expect(await badge()).toBe("!");
  });

  test("while Math PDF Reader has not answered, the status page says it is checking Math PDF Reader", async () => {
    await bucket.stop();
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: bucket.port,
      fetch: () => new Promise<Response>(() => undefined),
    });
    try {
      await openStatus("checking");
      expect(await text("#connection-heading")).toBe(
        "Checking Math PDF Reader…",
      );
    } finally {
      await silent.stop(true);
    }
  });

  test("with Math PDF Reader stopped, the status page says to open it from the application menu", async () => {
    await bucket.stop();
    await openStatus("unreachable");

    expect(await details()).toMatchObject({
      Address: bucket.origin,
      "Start it": "Open Math PDF Reader from the application menu",
    });
  });

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
      expect(await text("#connection-details")).toContain(
        "not a Math PDF Reader status report",
      );
      expect(await badge()).toBe("!");

      await followLinkToFailure("/abs/2401.00001");
      expect(await text("#details")).toContain("not with a capture response");
    } finally {
      await other.stop(true);
    }
  });
});
