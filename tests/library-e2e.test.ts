// End-to-end proof of the library window's workflows in the real UI: the built web bundle
// served by the real app over a temporary bucket of fixture PDFs, driven in Chromium with
// Puppeteer. Screenshots of every state land in $TMPDIR/pdf-bucket-library-e2e.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { build } from "vite";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import { OrganizationStore } from "../src/server/organization";
import { RESOLVERS_MANIFEST } from "../src/server/send";

setDefaultTimeout(30_000);

const config = loadAppConfig(CONFIG_PATH);
const fixtures = join(import.meta.dir, "fixtures");
const screenshots = join(tmpdir(), "pdf-bucket-library-e2e");
const viewport = { width: 1400, height: 900 };

// Items captured through the real capture endpoint: key, fixture file, link text.
const CAPTURES = [
  ["lattices", "lecture-notes.pdf", "Lectures on integral lattices"],
  ["problems", "problem-set.pdf", "Problem set on quadratic forms"],
  ["notes", "ten-page-notes.pdf", "Ten lectures on lattice theory"],
  ["reading", "ten-page-notes.pdf", "Ten lectures, the reading copy"],
] as const;

function executable(name: string): string {
  const path = Bun.which(name);
  if (path === null) {
    throw new Error(`${name} is not on PATH; the library suite drives the real browser`);
  }
  return path;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startBucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-"));
  // A port nothing listens on, so a send reaches for Zotero and fails instead of writing.
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const zoteroUrl = probe.url.origin;
  probe.stop(true);
  const app = createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    indexExport: null,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 0 });
  const origin = server.url.origin;
  for (const [key, file, linkText] of CAPTURES) {
    const form = new FormData();
    form.set("pdf", new File([readFileSync(join(fixtures, file))], `${key}.pdf`));
    form.set("pdf_url", `https://www.math.example.edu/~author/${key}.pdf`);
    form.set("source_url", "https://www.math.example.edu/~author/teaching.html");
    form.set("title_hint", linkText);
    const response = await fetch(`${origin}/capture-bytes`, { method: "POST", body: form });
    if (!response.ok) {
      throw new Error(`capture of ${key} failed: ${response.status} ${await response.text()}`);
    }
  }
  return { root, origin, stop: () => server.stop(true) };
}

// The store trashes deleted PDFs with send2trash, into $XDG_DATA_HOME/Trash when the PDF is on
// the home filesystem; a scratch XDG_DATA_HOME keeps the suite out of the user's own trash.
const scratchData = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-data-"));
const userData = process.env.XDG_DATA_HOME;

describe("library window", () => {
  let bucket: Awaited<ReturnType<typeof startBucket>>;
  let browser: Browser;
  let page: Page;

  const shot = async (name: string) => {
    await page.screenshot({ path: join(screenshots, `${name}.png`) });
  };
  // The filing as the server wrote it to disk.
  const organization = () => new OrganizationStore(bucket.root).read();
  const row = (key: string) => `tr[data-item-id="${key}"]`;
  const rowKeys = () =>
    page.$$eval("tr[data-item-id]", (rows) => rows.map((tr) => tr.getAttribute("data-item-id")));
  // The element with this ARIA role whose text is exactly LABEL, once it is on the page.
  const byRole = async (role: string, label: string) => {
    const selector = `[role="${role}"], ${role}`;
    const text = (element: Element) => element.textContent?.trim();
    await page.waitForFunction(
      (css, wanted) =>
        [...document.querySelectorAll(css)].some(
          (element) => element.textContent?.trim() === wanted,
        ),
      {},
      selector,
      label,
    );
    for (const element of await page.$$(selector)) {
      if ((await element.evaluate(text)) === label) {
        return element;
      }
    }
    throw new Error(`no ${role} ${label}`);
  };
  const menuItem = (label: string) => byRole("menuitem", label);
  const openLibrary = async () => {
    await page.goto(`${bucket.origin}/`);
    await page.waitForSelector(row("lattices"));
  };

  beforeAll(async () => {
    process.env.XDG_DATA_HOME = scratchData;
    mkdirSync(screenshots, { recursive: true });
    // The app serves the bundle in dist/web; build it from the current source.
    await build({
      configFile: join(import.meta.dir, "../src/web/vite.config.ts"),
      logLevel: "warn",
    });
    bucket = await startBucket();
    browser = await puppeteer.launch({
      browser: "chrome",
      executablePath: executable("chromium"),
      headless: true,
      defaultViewport: viewport,
    });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    bucket.stop();
    if (userData === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = userData;
    }
  });

  test("typing a new collection name in the details files the item into that new collection", async () => {
    await openLibrary();
    await page.click(row("lattices"));
    await page.click('button[aria-label="Add to collection"]');
    await page.type('input[aria-label="Collection"]', "Birational geometry");
    await shot("details-new-collection");
    await page.keyboard.press("Enter");
    await page.waitForSelector("aside ::-p-text(Birational geometry)");
    await shot("details-filed");

    const org = await organization();
    const created = org.collections.filter(
      (collection) => collection.name === "Birational geometry",
    );
    expect(org.items.lattices?.collections).toEqual(created.map((collection) => collection.id));
    expect(created).toHaveLength(1);
  });

  test("the row context menu adds a tag and files into a new collection", async () => {
    await openLibrary();
    await page.click(row("problems"), { button: "right" });
    await shot("row-context-menu");
    await (await menuItem("Add to Collection")).hover();
    await (await menuItem("New Collection…")).click();
    await page.type('[role="dialog"] input', "Quadratic forms");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector('[role="menu"]') === null &&
        document.querySelector('[role="dialog"]') === null,
    );

    await page.click(row("problems"), { button: "right" });
    await (await menuItem("Add Tag…")).click();
    await page.type('[role="dialog"] input', "exercises");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${row("problems")} ::-p-text(exercises)`);

    const org = await organization();
    const quadratic = org.collections.filter((collection) => collection.name === "Quadratic forms");
    expect(quadratic).toHaveLength(1);
    expect(org.items.problems?.collections).toEqual(quadratic.map((collection) => collection.id));
    expect(org.items.problems?.tags).toEqual(["exercises"]);
  });

  test("Delete in the row context menu moves the PDF to the trash and drops the item", async () => {
    await openLibrary();
    const pdf = join(bucket.root, "notes.pdf");
    const bytes = sha256(readFileSync(pdf));
    await page.click(row("notes"), { button: "right" });
    await (await menuItem("Delete…")).click();
    await shot("delete-confirm");
    await (await byRole("button", "Delete")).click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector) === null,
      {},
      row("notes"),
    );

    expect(await rowKeys()).not.toContain("notes");
    expect(existsSync(pdf)).toBe(false);
    const trash = join(scratchData, "Trash", "files");
    const trashed = readdirSync(trash)
      .filter((name) => name.startsWith("notes"))
      .map((name) => sha256(readFileSync(join(trash, name))));
    expect(trashed).toContain(bytes);
    expect((await organization()).items.notes).toBeUndefined();
  });

  test("Ctrl+F searches the table, Ctrl+P goes to an item by fuzzy title, Ctrl+Shift+P runs a command", async () => {
    await openLibrary();
    await page.keyboard.down("Control");
    await page.keyboard.press("f");
    await page.keyboard.up("Control");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(focused).toBe("Search");
    await page.keyboard.type("quadratic");
    await page.waitForFunction(() => document.querySelectorAll("tr[data-item-id]").length === 1);
    expect(await rowKeys()).toEqual(["problems"]);
    await page.click('input[aria-label="Search"]', { count: 3 });
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelectorAll("tr[data-item-id]").length > 1);

    await page.keyboard.down("Control");
    await page.keyboard.press("p");
    await page.keyboard.up("Control");
    await page.keyboard.type("intlat");
    await shot("palette-items");
    await page.keyboard.press("Enter");
    await page.waitForSelector("aside h2 ::-p-text(Lectures on integral lattices)");

    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("p");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await page.keyboard.type("unfiled");
    await shot("palette-commands");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash === "#/unfiled");
  });

  test("reader back and forward walk the positions visited in the PDF and stay in it; Library returns to the view the PDF was opened from", async () => {
    await page.goto(`${bucket.origin}/#/unfiled`);
    await page.waitForSelector(row("reading"));
    await page.click(row("reading"), { count: 2 });
    await page.waitForFunction(() => location.pathname === "/read/reading");
    const viewer = await (await page.waitForSelector("iframe"))?.contentFrame();
    if (viewer === undefined || viewer === null) {
      throw new Error("the reader has no viewer frame");
    }
    await viewer.waitForFunction("window.PDFViewerApplication?.pdfDocument?.numPages === 10");
    // Follows a link to a page, as an outline entry or an internal link in the PDF does.
    const followLinkTo = async (pageNumber: number) => {
      await viewer.evaluate(`PDFViewerApplication.pdfLinkService.goToPage(${pageNumber})`);
      await viewer.waitForFunction(`PDFViewerApplication.page === ${pageNumber}`);
    };
    await followLinkTo(7);
    await followLinkTo(3);
    await shot("reader");

    const back = 'button[aria-label="Back"]';
    const forward = 'button[aria-label="Forward"]';
    await page.click(back);
    await viewer.waitForFunction("PDFViewerApplication.page === 7");
    await page.click(back);
    await viewer.waitForFunction("PDFViewerApplication.page === 1");
    expect(await page.$eval(back, (button) => (button as HTMLButtonElement).disabled)).toBe(true);
    await page.keyboard.down("Alt");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Alt");
    expect(new URL(page.url()).pathname).toBe("/read/reading");
    expect(await viewer.evaluate("PDFViewerApplication.page")).toBe(1);
    await page.click(forward);
    await viewer.waitForFunction("PDFViewerApplication.page === 7");
    await page.waitForFunction(() => location.hash.includes("page=7"));
    const address = page.url();

    await page.click('a[aria-label="Library"]');
    await page.waitForSelector(row("reading"));
    expect(new URL(page.url()).hash).toBe("#/unfiled");

    await page.goto(address);
    const reopened = await (await page.waitForSelector("iframe"))?.contentFrame();
    if (reopened === undefined || reopened === null) {
      throw new Error("the reader has no viewer frame");
    }
    await reopened.waitForFunction("window.PDFViewerApplication?.page === 7");
    await page.setViewport({ width: 700, height: 900 });
    await shot("reader-narrow");
    await page.setViewport(viewport);
  });

  test("the library at a narrow width", async () => {
    await openLibrary();
    await page.click(row("lattices"));
    await page.setViewport({ width: 800, height: 900 });
    await shot("library-narrow");
    await page.setViewport(viewport);
    await shot("library");
    const views = await page.$$eval("nav a", (links) =>
      links.map((link) => link.textContent?.trim()),
    );
    expect(views.slice(0, 2)).toEqual(["Library", "Unfiled"]);
  });
});
