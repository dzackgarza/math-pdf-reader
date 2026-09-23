// Browser end-to-end proof of capture (#6): both built extensions, driven by Puppeteer
// (Chromium through --load-extension, Firefox through WebDriver BiDi webExtension.install),
// against the fixture site and an in-process bucket over a temporary store.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { build } from "wxt";
import { z } from "zod";
import { pdfCaptureRules } from "../src/extension/interception";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { listItems } from "../src/server/store";
import { extensionDefine } from "../wxt.config";
import { lectureNotes, problemSet, startFixtureSite } from "./fixture-site";

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

function startBucket(port: number) {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-e2e-store-"));
  const app = createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl: config.zotero.url,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
  if (server.port === undefined) {
    throw new Error("the bucket server did not bind a TCP port");
  }
  return {
    root,
    port: server.port,
    origin: `http://127.0.0.1:${server.port}`,
    files: () => readdirSync(root).sort(),
    stop: () => server.stop(true),
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

async function launch(engine: Engine, extension: string): Promise<Browser> {
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
    return browser;
  }
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: executable("firefox"),
    headless: true,
    defaultViewport: viewport,
    // The capture page is a moz-extension (privileged) document; BiDi scripts it only then.
    args: ["-remote-allow-system-access"],
  });
  await browser.installExtension(extension);
  return browser;
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
  let bucket: ReturnType<typeof startBucket>;
  let browser: Browser;
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

  const provenance = async (key: string) => (await listItems(bucket.root, [key]))[0]?.provenance;
  const served = () => site.requests.map((request) => `${request.method} ${request.path}`);

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    const probe = startBucket(0);
    probe.stop();
    bucket = startBucket(probe.port);
    browser = await launch(engine, await buildExtension(engine, bucket.port));
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    bucket.stop();
    site.stop();
  });

  test("an arXiv /pdf/ URL without .pdf is captured with the linking page and link text", async () => {
    await followLink("/abs/2401.00001");
    await captureState(page, "stored");

    expect(bucket.files()).toEqual(["2401.00001.pdf"]);
    const stored = await provenance("2401.00001");
    expect(stored.pdf_url).toBe(`${site.origin}/pdf/2401.00001`);
    expect(stored.source_url).toBe(`${site.origin}/abs/2401.00001`);
    expect(stored.title_hint).toBe("Sphere packing in dimension 8 (PDF)");
    expect(stored.original_sha256).toBe(sha256(problemSet));
  });

  test("a .pdf URL is captured once; navigating to it again opens the existing item", async () => {
    await followLink("/teaching.html");
    await captureState(page, "stored");
    await shotCapturePage("stored");
    const stored = await provenance("lecture-notes");
    expect(stored.source_url).toBe(`${site.origin}/teaching.html`);
    expect(stored.title_hint).toBe("Lecture notes on lattices");
    expect(stored.original_sha256).toBe(sha256(lectureNotes));
    const storedBytes = sha256(readFileSync(join(bucket.root, "lecture-notes.pdf")));

    await followLink("/teaching.html");
    await captureState(page, "stored");
    await shotCapturePage("existing");
    expect(bucket.files()).toEqual(["2401.00001.pdf", "lecture-notes.pdf"]);
    expect(sha256(readFileSync(join(bucket.root, "lecture-notes.pdf")))).toBe(storedBytes);
  });

  test("a Content-Disposition download is captured under its declared filename", async () => {
    await followLink("/downloads.html");
    await captureState(page, "stored");

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
    bucket.stop();

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
});
