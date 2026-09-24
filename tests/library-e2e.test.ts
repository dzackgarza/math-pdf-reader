// End-to-end proof of the library window's workflows in the real UI: the built web bundle
// served by the real app over a temporary bucket of fixture PDFs, driven in Chromium with
// Puppeteer. Screenshots of every state land in $TMPDIR/pdf-bucket-library-e2e.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { build } from "vite";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import { type BucketItem, LibraryPayloadSchema } from "../src/server/libraryContract";
import { OrganizationStore } from "../src/server/organization";
import { RESOLVERS_MANIFEST } from "../src/server/send";
import { SCRATCH_DATA_HOME } from "./preload";

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

// The publisher the fixtures were captured from: what each path serves right now.
const served = new Map<string, Uint8Array<ArrayBuffer>>(
  CAPTURES.map(([key, file]) => [
    `/~author/${key}.pdf`,
    new Uint8Array(readFileSync(join(fixtures, file))),
  ]),
);
const publisher = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const bytes = served.get(new URL(request.url).pathname);
    return bytes === undefined
      ? new Response("not found", { status: 404 })
      : new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
  },
});
const published = (path: string) => new URL(path, publisher.url).href;

async function startBucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-"));
  const indexExport = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-export-")),
    "index.json",
  );
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
    indexExport,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 0 });
  const origin = server.url.origin;
  for (const [key, file, linkText] of CAPTURES) {
    const form = new FormData();
    form.set("pdf", new File([readFileSync(join(fixtures, file))], `${key}.pdf`));
    form.set("pdf_url", published(`/~author/${key}.pdf`));
    form.set("source_url", published("/~author/teaching.html"));
    form.set("title_hint", linkText);
    const response = await fetch(`${origin}/capture-bytes`, { method: "POST", body: form });
    if (!response.ok) {
      throw new Error(`capture of ${key} failed: ${response.status} ${await response.text()}`);
    }
  }
  return { root, origin, indexExport, stop: () => server.stop(true) };
}

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
  // The library with no particular row expected (some may be missing from the store).
  const openRoot = async () => {
    await page.goto(`${bucket.origin}/`);
    await page.waitForSelector("nav a");
  };

  beforeAll(async () => {
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
    publisher.stop(true);
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
    const trash = join(SCRATCH_DATA_HOME, "Trash", "files");
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
    // Follows a link to a page, as an outline entry or an internal link in the PDF does, and
    // waits for the view update that records the position reached.
    const followLinkTo = async (pageNumber: number) => {
      await viewer.evaluate(`PDFViewerApplication.pdfLinkService.goToPage(${pageNumber})`);
      await page.waitForFunction((n) => location.hash.startsWith(`#page=${n}&`), {}, pageNumber);
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

  test("a text note written on a page in the reader is saved into the PDF and is there after a reload", async () => {
    const openViewer = async () => {
      await page.goto(`${bucket.origin}/read/problems`);
      const frame = await (await page.waitForSelector("iframe"))?.contentFrame();
      if (frame === undefined || frame === null) {
        throw new Error("the reader has no viewer frame");
      }
      await frame.waitForFunction("window.PDFViewerApplication?.pdfDocument?.numPages > 0");
      return frame;
    };
    const note = `Checked the Hasse–Minkowski step ${Date.now()}`;
    const viewer = await openViewer();
    // PDF.js's free-text tool, as its toolbar button selects it; a click on the page places a
    // note there.
    await viewer.evaluate(
      "PDFViewerApplication.eventBus.dispatch('switchannotationeditormode', { source: null, mode: pdfjsLib.AnnotationEditorType.FREETEXT })",
    );
    const layer = await viewer.waitForSelector(
      '.page[data-page-number="1"] .annotationEditorLayer',
    );
    await layer?.click({ offset: { x: 120, y: 160 } });
    await viewer.waitForSelector(".freeTextEditor .internal");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/problems/pdf") && response.request().method() === "PUT",
    );
    await page.keyboard.type(note);
    await page.keyboard.press("Escape");
    await viewer.evaluate(
      "PDFViewerApplication.eventBus.dispatch('switchannotationeditormode', { source: null, mode: pdfjsLib.AnnotationEditorType.NONE })",
    );
    expect((await saved).status()).toBe(200);
    await shot("reader-annotated");

    const reopened = await openViewer();
    // The annotations PDF.js reads from the stored file, not from the editor it drew.
    const contents = z
      .array(z.string())
      .parse(
        await reopened.evaluate(
          "(async () => (await (await PDFViewerApplication.pdfDocument.getPage(1)).getAnnotations()).filter((a) => a.contentsObj).map((a) => a.contentsObj.str))()",
        ),
      );
    expect(contents).toContain(note);
  });

  test("the reader records the last viewed page, the library shows it out of the page count, and the reader reopens there", async () => {
    const openReading = async () => {
      await page.goto(`${bucket.origin}/read/reading`);
      const frame = await (await page.waitForSelector("iframe"))?.contentFrame();
      if (frame === undefined || frame === null) {
        throw new Error("the reader has no viewer frame");
      }
      await frame.waitForFunction("window.PDFViewerApplication?.pdfDocument?.numPages === 10");
      return frame;
    };
    const viewer = await openReading();
    const recorded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/reading/reading") &&
        response.request().postData() === JSON.stringify({ page: 4, pages: 10 }),
    );
    await viewer.evaluate("PDFViewerApplication.page = 4");
    expect((await recorded).status()).toBe(200);

    await openLibrary();
    expect(await page.$eval(`${row("reading")} [data-reading]`, (cell) => cell.textContent)).toBe(
      "4 / 10",
    );
    expect(await page.$eval(`${row("lattices")} [data-reading]`, (cell) => cell.textContent)).toBe(
      "Unread",
    );
    await shot("library-reading");

    const reopened = await openReading();
    await reopened.waitForFunction("PDFViewerApplication.page === 4");
  });

  test("the grid view shows each PDF's first page, and a double-click opens the reader", async () => {
    await openLibrary();
    const keys = (await rowKeys()).sort();
    await page.click('button[aria-label="Grid view"]');
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll("[data-card-id] img").length === count &&
        [...document.querySelectorAll<HTMLImageElement>("[data-card-id] img")].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      {},
      keys.length,
    );
    await shot("library-grid");
    expect(
      (
        await page.$$eval("[data-card-id]", (cards) =>
          cards.map((card) => card.getAttribute("data-card-id")),
        )
      ).sort(),
    ).toEqual(keys);

    await page.click('[data-card-id="reading"]');
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLImageElement>('aside img[alt="First page"]')?.naturalWidth ?? 0,
    );
    await page.click('[data-card-id="reading"]', { count: 2 });
    await page.waitForFunction(() => location.pathname === "/read/reading");

    // The layout is kept for the next visit; the list comes back only when chosen.
    await openRoot();
    await page.waitForSelector('[data-card-id="reading"]');
    await page.click('button[aria-label="List view"]');
    await page.waitForSelector(row("reading"));
  });

  test("the library at a narrow width", async () => {
    await openLibrary();
    await page.click(row("lattices"));
    await page.setViewport({ width: 800, height: 900 });
    await shot("library-narrow");
    await page.setViewport(viewport);
    await shot("library");
  });

  test("Verify marks a PDF whose URL no longer serves it Offline; a mirror that serves it keeps it Cached", async () => {
    served.delete("/~author/problems.pdf");
    await openLibrary();
    const status = () => page.$eval(`${row("problems")} [data-status]`, (cell) => cell.textContent);
    expect(await status()).toBe("Cached");
    await page.click(row("problems"));
    const details = 'aside[aria-label="Item details"]';
    await page.click(`${details} button[aria-label="Verify sources"]`);
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent === "Offline",
      {},
      `${row("problems")} [data-status]`,
    );
    await page.click('button[aria-label="Offline"]');
    await page.waitForFunction(() => location.hash === "#/offline");
    expect(await rowKeys()).toEqual(["problems"]);
    await shot("details-offline");

    served.set(
      "/~author/mirror/problems.pdf",
      new Uint8Array(readFileSync(join(fixtures, "problem-set.pdf"))),
    );
    await page.click(row("problems"));
    await page.type(
      `${details} input[aria-label="Mirror URL"]`,
      published("/~author/mirror/problems.pdf"),
    );
    await page.keyboard.press("Enter");
    await page.waitForSelector(
      `${details} ::-p-text(${published("/~author/mirror/problems.pdf")})`,
    );
    await page.click(`${details} button[aria-label="Verify sources"]`);
    await page.waitForFunction(
      (selector) => document.querySelector(selector) === null,
      {},
      row("problems"),
    );
    await page.click('button[aria-label="Offline"]');
    await page.waitForSelector(row("problems"));
    expect(await status()).toBe("Cached");
    await shot("details-mirror");
  });

  test("a lost PDF the export holds is listed under Needs Re-fetch until Rebuild restores it", async () => {
    // The export is written after every change; wait until it holds the item to be lost.
    const exported = async () =>
      existsSync(bucket.indexExport) ? readFileSync(bucket.indexExport, "utf8") : "";
    while (!(await exported()).includes('"key": "lattices"')) {
      await Bun.sleep(50);
    }
    const away = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-away-"));
    renameSync(join(bucket.root, "lattices.pdf"), join(away, "lattices.pdf"));

    await openRoot();
    await page.waitForSelector('button[aria-label="Needs Re-fetch"]');
    await page.click('button[aria-label="Needs Re-fetch"]');
    await page.waitForFunction(() => location.hash === "#/needs-refetch");
    await page.waitForSelector('[data-missing-key="lattices"]');
    await shot("library-needs-refetch");
    await page.click('[data-missing-key="lattices"] button[aria-label="Rebuild"]');
    await page.waitForFunction(
      () => document.querySelector('[data-missing-key="lattices"]') === null,
    );

    await openLibrary();
    expect(await rowKeys()).toContain("lattices");
    expect(existsSync(join(bucket.root, "lattices.pdf"))).toBe(true);
  });

  test("the Library entry counts the PDFs; each quick filter narrows the library and a second click clears it", async () => {
    await openLibrary();
    const payload = LibraryPayloadSchema.parse(
      await (await fetch(`${bucket.origin}/api/library`)).json(),
    );
    const keysWhere = (keep: (item: BucketItem) => boolean) =>
      payload.items
        .filter(keep)
        .map((item) => item.id)
        .sort();
    const all = keysWhere(() => true);
    const filters = [
      {
        name: "Unfiled",
        hash: "#/unfiled",
        keys: keysWhere((item) => item.collections.length === 0),
      },
      {
        name: "Unread",
        hash: "#/unread",
        keys: keysWhere((item) => item.reading.status === "unread"),
      },
    ];
    const sortedRows = async () => (await rowKeys()).sort();
    const rowCount = (count: number) =>
      page.waitForFunction(
        (wanted) => document.querySelectorAll("tr[data-item-id]").length === wanted,
        {},
        count,
      );
    const chip = (name: string) => `button[aria-label="${name}"]`;
    const pressed = (name: string) =>
      page.$eval(chip(name), (button) => button.getAttribute("aria-pressed"));

    expect(await page.$eval("nav a", (link) => link.textContent?.trim())).toBe(
      `Library${all.length}`,
    );
    for (const filter of filters) {
      // Each filter must discriminate: it keeps some items and drops others.
      expect(filter.keys.length).toBeGreaterThan(0);
      expect(filter.keys.length).toBeLessThan(all.length);
      expect(await page.$eval(chip(filter.name), (button) => button.textContent?.trim())).toBe(
        `${filter.name}${filter.keys.length}`,
      );
      await page.click(chip(filter.name));
      await page.waitForFunction((hash) => location.hash === hash, {}, filter.hash);
      await rowCount(filter.keys.length);
      expect(await sortedRows()).toEqual(filter.keys);
      expect(await pressed(filter.name)).toBe("true");
      expect(await page.$eval("nav a", (link) => link.getAttribute("aria-current"))).toBe("page");
    }
    await shot("library-quick-filter");

    const last = filters[filters.length - 1]?.name ?? "";
    await page.click(chip(last));
    await rowCount(all.length);
    expect(await sortedRows()).toEqual(all);
    expect(await pressed(last)).toBe("false");
  });

  test("the Sort menu orders the table by the chosen column and direction", async () => {
    await openLibrary();
    const titles = async () =>
      page.$$eval(`tr[data-item-id] td[data-column="title"]`, (cells) =>
        cells.map((cell) => cell.textContent?.trim() ?? ""),
      );
    const expected = [...(await titles())].sort((a, b) => a.localeCompare(b));

    await page.click('button[aria-label="Sort"]');
    await (await byRole("menuitemradio", "Title")).click();
    await page.waitForFunction(() => document.querySelector('[role="menu"]') === null);
    await page.click('button[aria-label="Sort"]');
    await (await byRole("menuitemradio", "Ascending")).click();
    await shot("library-sorted");
    expect(await titles()).toEqual(expected);

    await page.click('button[aria-label="Sort"]');
    await (await byRole("menuitemradio", "Descending")).click();
    expect(await titles()).toEqual([...expected].reverse());
  });
});
