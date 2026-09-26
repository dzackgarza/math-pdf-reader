// End-to-end proof of the library window's workflows in the real UI: the built web bundle
// served by the real app over a temporary bucket of fixture PDFs, driven in Chromium with
// Puppeteer. Screenshots of every state land in $TMPDIR/pdf-bucket-library-e2e.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { build } from "vite";
import { z } from "zod";
import { CaptureResponseSchema } from "../src/contract/capture";
import { type BucketItem, LibraryPayloadSchema } from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";
import { SCRATCH_DATA_HOME } from "./preload";
import { readOrganization } from "./store";

setDefaultTimeout(30_000);

const fixtures = join(import.meta.dir, "fixtures");
const screenshots = join(tmpdir(), "pdf-bucket-library-e2e");
const viewport = { width: 1400, height: 900 };

// The bytes of a committed fixture PDF.
const fixture = (file: string) => new Uint8Array(readFileSync(join(fixtures, file)));
// The ten-page notes with a comment after their end: the same pages as another PDF, so the
// store keeps it as its own item.
const readingCopy = new Uint8Array([
  ...fixture("ten-page-notes.pdf"),
  ...new TextEncoder().encode("% the reading copy\n"),
]);

// Items captured through the real capture endpoint: key, PDF bytes, link text.
const CAPTURES = [
  ["lattices", fixture("lecture-notes.pdf"), "Lectures on integral lattices"],
  ["problems", fixture("problem-set.pdf"), "Problem set on quadratic forms"],
  ["notes", fixture("ten-page-notes.pdf"), "Ten lectures on lattice theory"],
  ["reading", readingCopy, "Ten lectures, the reading copy"],
  // Its catalog asks viewers to open its outline (/PageMode /UseOutlines).
  ["outlined", fixture("outlined-notes.pdf"), "Ten lectures with an outline"],
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
  CAPTURES.map(([key, bytes]) => [`/~author/${key}.pdf`, bytes]),
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
  const app = await serveBucket({
    root,
    zoteroUrl,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport,
  });
  const origin = app.origin;
  for (const [key, bytes, linkText] of CAPTURES) {
    const form = new FormData();
    form.set("pdf", new File([bytes], `${key}.pdf`));
    form.set("pdf_url", published(`/~author/${key}.pdf`));
    form.set("source_url", published("/~author/teaching.html"));
    form.set("title_hint", linkText);
    const response = await fetch(`${origin}/capture-bytes`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      throw new Error(`capture of ${key} failed: ${response.status} ${await response.text()}`);
    }
  }
  return { root, origin, indexExport, stop: app.stop };
}

describe("library window", () => {
  let bucket: Awaited<ReturnType<typeof startBucket>>;
  let browser: Browser;
  let page: Page;

  const shot = async (name: string) => {
    await page.screenshot({ path: join(screenshots, `${name}.png`) });
  };
  // The filing as the server wrote it to disk.
  const organization = async () => readOrganization(bucket.root);
  const row = (key: string) => `tr[data-item-id="${key}"]`;
  const rowKeys = () =>
    page.$$eval("tr[data-item-id]", (rows) => rows.map((tr) => tr.getAttribute("data-item-id")));
  // Waits until the element at SELECTOR shows TEXT. Its text only: `::-p-text` also matches the
  // value typed into a field, so it passes while the change is still on its way to the server.
  const shows = (selector: string, text: string) =>
    page.waitForFunction(
      (css, wanted) => document.querySelector(css)?.textContent?.includes(wanted) === true,
      {},
      selector,
      text,
    );
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
  const tab = (key: string) => `[data-tab-key="${key}"]`;
  // True in the window once the PDF.js viewer of the reader page in FRAME has the PDF's pages.
  const pdfLoadedIn = (frame: string) =>
    `document.querySelector('${frame}')?.contentDocument?.querySelector("iframe")?.contentWindow?.PDFViewerApplication?.pdfViewer?.pagesCount > 0`;
  const openTabKeys = () =>
    page.$$eval("[data-tab-key]", (tabs) =>
      tabs.map((element) => element.getAttribute("data-tab-key")),
    );
  // What the desktop app's tray Quit hears back from the library (follow-open-events.js).
  const quitOutcome = () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const pending: Promise<void>[] = [];
          window.dispatchEvent(
            new CustomEvent("pdf-bucket-quit", {
              detail: {
                waitUntil: (settled: Promise<void>) => pending.push(settled),
              },
            }),
          );
          Promise.all(pending).then(
            () => resolve("settled"),
            () => resolve("failed"),
          );
        }),
    );
  // The PDF tab for KEY, once it is the tab shown and its viewer has the PDF's pages: the
  // reader page it frames and that page's PDF.js viewer.
  const shownReader = async (key: string) => {
    await page.waitForSelector(`${tab(key)}[data-state="active"]`);
    // A frame handle taken while a new tab's frame still holds its initial empty document can
    // detach when the reader page replaces it, so the handles are taken once the PDF is up.
    const frameSelector = `iframe[data-reader-key="${key}"]`;
    await page.waitForFunction(pdfLoadedIn(frameSelector));
    const reader = await (
      await page.waitForSelector(frameSelector, { visible: true })
    )?.contentFrame();
    if (reader === undefined || reader === null) {
      throw new Error(`the tab of ${key} frames no reader`);
    }
    const viewer = await (await reader.waitForSelector("iframe"))?.contentFrame();
    if (viewer === undefined || viewer === null) {
      throw new Error("the reader has no viewer frame");
    }
    await viewer.waitForFunction("window.PDFViewerApplication?.pdfViewer?.pagesCount > 0");
    return { reader, viewer };
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
    await browser
      .defaultBrowserContext()
      .overridePermissions(bucket.origin, ["clipboard-read", "clipboard-sanitized-write"]);
    page = await browser.newPage();
  }, 60_000);

  // Runs also when a test or the setup fails; closing the browser removes its profile.
  afterAll(async () => {
    publisher.stop(true);
    await bucket.stop();
    await browser.close();
  });

  test("typing a new collection name in the details files the item into that new collection", async () => {
    await openLibrary();
    await page.click(row("lattices"));
    await page.click('button[aria-label="Add to collection"]');
    await page.type('input[aria-label="Collection"]', "Birational geometry");
    await shot("details-new-collection");
    await page.keyboard.press("Enter");
    await shows("aside", "Birational geometry");
    await shot("details-filed");

    const org = await organization();
    const created = org.collections.filter(
      (collection) => collection.name === "Birational geometry",
    );
    expect(org.items.lattices?.collections).toEqual(created.map((collection) => collection.id));
    expect(created).toHaveLength(1);
  });

  test("the details pane edits bibliographic metadata and shows the saved values after reload", async () => {
    const form = new FormData();
    const bytes = new Uint8Array([
      ...fixture("lecture-notes.pdf"),
      ...new TextEncoder().encode("% metadata editor fixture\n"),
    ]);
    form.set("pdf", new File([bytes], "manual-edit.pdf"));
    form.set("pdf_url", published("/~author/manual-edit.pdf"));
    form.set("source_url", published("/~author/teaching.html"));
    form.set("title_hint", "Download PDF");
    const response = await fetch(`${bucket.origin}/capture-bytes`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    const captured = CaptureResponseSchema.parse(await response.json());
    expect(captured.key).toBe("manual-edit");
    try {
      await openLibrary();
      await page.click(row(captured.key));
      await page.click('button[aria-label="Edit metadata"]');
      await page.waitForSelector('input[aria-label="Title"]');
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('aside img[alt="First page"]');
        return image?.complete === true && image.naturalWidth > 0;
      });
      await shot("details-metadata-edit");
      await page.setViewport({ width: 700, height: 900 });
      await shot("details-metadata-edit-narrow");
      await page.setViewport(viewport);

      await page.click('input[aria-label="Title"]', { count: 3 });
      await page.keyboard.press("Backspace");
      await page.type('input[aria-label="Title"]', "Corrected title from the paper");
      await page.type(
        'textarea[aria-label="Authors, one per line"]',
        "Ada Researcher\nBenoit Scholar",
      );
      await page.type('input[aria-label="Year"]', "2024");
      await page.type('textarea[aria-label="Abstract"]', "A corrected abstract.");
      await shot("details-metadata-filled");
      await (await byRole("button", "Save metadata")).click();
      await shows("aside h2", "Corrected title from the paper");
      await shot("details-metadata-saved");

      await openLibrary();
      await page.click(row(captured.key));
      expect(await page.$eval("aside h2", (heading) => heading.textContent)).toBe(
        "Corrected title from the paper",
      );
      expect(await page.$eval("aside header", (header) => header.textContent)).toContain(
        "Ada Researcher, Benoit Scholar · 2024",
      );
      const payload = LibraryPayloadSchema.parse(
        await (await fetch(`${bucket.origin}/api/library`)).json(),
      );
      expect(payload.items.find((item) => item.id === captured.key)).toMatchObject({
        titleSource: "manual",
        abstract: "A corrected abstract.",
      });
    } finally {
      await fetch(`${bucket.origin}/api/items/${captured.key}`, {
        method: "DELETE",
      });
    }
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
    await shows(row("problems"), "exercises");

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

  test("reader back and forward walk the positions visited in the PDF and stay in it; on its own, the reader's Library returns to the view the library last showed", async () => {
    await page.goto(`${bucket.origin}/#/unfiled`);
    await page.waitForSelector(row("reading"));
    await page.goto(`${bucket.origin}/read/reading`);
    const viewer = await (await page.waitForSelector("iframe"))?.contentFrame();
    if (viewer === undefined || viewer === null) {
      throw new Error("the reader has no viewer frame");
    }
    await viewer.waitForFunction("window.PDFViewerApplication?.pdfViewer?.pagesCount === 10");
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

  test("the reader link button copies the captured PDF URL", async () => {
    await page.goto(`${bucket.origin}/read/lattices`);
    await page.waitForFunction(
      'document.querySelector("iframe")?.contentWindow?.PDFViewerApplication?.pdfViewer?.pagesCount > 0',
    );
    await page.evaluate(() => navigator.clipboard.writeText("probe"));

    await page.click('button[aria-label="Copy PDF link"]');

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      published("/~author/lattices.pdf"),
    );
  });

  test("each PDF opens in its own tab after the Library tab, which keeps its selection; opening an open PDF shows its tab; Ctrl+Tab steps through the tabs and Ctrl+W closes the one shown", async () => {
    const payload = LibraryPayloadSchema.parse(
      await (await fetch(`${bucket.origin}/api/library`)).json(),
    );
    const titleOf = (key: string) => {
      const item = payload.items.find((candidate) => candidate.id === key);
      if (item === undefined) {
        throw new Error(`the library holds no ${key}`);
      }
      return item.title;
    };
    await openLibrary();
    await page.click(row("problems"), { count: 2 });
    // The Library tab is shown again, and the PDF loads while its tab is hidden.
    await page.waitForSelector(`${tab("problems")}[data-state="active"]`);
    await (await byRole("tab", "Library")).click();
    await page.waitForSelector(`${row("problems")}[aria-selected="true"]`, {
      visible: true,
    });
    expect(new URL(page.url()).pathname).toBe("/");
    await page.waitForFunction(pdfLoadedIn('iframe[data-reader-key="problems"]'));
    await page.keyboard.press("Enter");
    const problems = await shownReader("problems");
    expect(await openTabKeys()).toEqual(["problems"]);
    // Loaded while hidden, the PDF still draws its pages once its tab is shown.
    await problems.viewer.waitForFunction(
      `document.querySelector('.page[data-page-number="1"] canvas')?.width > 0`,
    );
    expect(await page.$eval(tab("problems"), (element) => element.textContent)).toBe(
      titleOf("problems"),
    );
    // The tab strip holds the way back, so the reader in a tab shows no Library link.
    expect(await problems.reader.$eval("#library", (link) => link.checkVisibility())).toBe(false);
    await shot("tabs-reader");

    await (await byRole("tab", "Library")).click();
    await page.click(row("reading"));
    await page.keyboard.press("Enter");
    const reading = await shownReader("reading");
    expect(await openTabKeys()).toEqual(["problems", "reading"]);
    await shot("tabs-two");

    // Keys pressed while reading reach the tab strip from inside the PDF.
    await reading.viewer.click("#viewerContainer");
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.waitForSelector(row("reading"), { visible: true });
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    await shownReader("reading");
    await page.keyboard.press("w");
    await page.keyboard.up("Control");
    await shownReader("problems");
    expect(await openTabKeys()).toEqual(["problems"]);

    await page.click(`${tab("problems")} button[aria-label^="Close"]`);
    await page.waitForSelector(row("problems"), { visible: true });
    expect(await openTabKeys()).toEqual([]);
  });

  test("closing a PDF's tab right after a note is written saves the note into the PDF first", async () => {
    await openLibrary();
    await page.click(row("outlined"), { count: 2 });
    const { viewer } = await shownReader("outlined");
    await viewer.waitForFunction(
      "PDFViewerApplication.pdfViewer.annotationEditorMode !== pdfjsLib.AnnotationEditorType.DISABLE",
    );
    await viewer.evaluate(
      "PDFViewerApplication.eventBus.dispatch('switchannotationeditormode', { source: null, mode: pdfjsLib.AnnotationEditorType.FREETEXT })",
    );
    const layer = await viewer.waitForSelector(
      '.page[data-page-number="1"] .annotationEditorLayer',
    );
    await layer?.click({ offset: { x: 120, y: 160 } });
    await viewer.waitForSelector(".freeTextEditor .internal");
    const note = `Closed at once ${Date.now()}`;
    await page.keyboard.type(note);
    await page.keyboard.press("Escape");
    await viewer.evaluate(
      "PDFViewerApplication.eventBus.dispatch('switchannotationeditormode', { source: null, mode: pdfjsLib.AnnotationEditorType.NONE })",
    );
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/outlined/pdf") && response.request().method() === "PUT",
    );
    await page.click(`${tab("outlined")} button[aria-label^="Close"]`);
    expect((await saved).status()).toBe(200);
    await page.waitForSelector(row("outlined"), { visible: true });

    await page.goto(`${bucket.origin}/read/outlined`);
    const reopened = await (await page.waitForSelector("iframe"))?.contentFrame();
    if (reopened === undefined || reopened === null) {
      throw new Error("the reader has no viewer frame");
    }
    await reopened.waitForFunction("window.PDFViewerApplication?.pdfDocument?.numPages > 0");
    const contents = z
      .array(z.string())
      .parse(
        await reopened.evaluate(
          "(async () => (await (await PDFViewerApplication.pdfDocument.getPage(1)).getAnnotations()).filter((a) => a.contentsObj).map((a) => a.contentsObj.str))()",
        ),
      );
    expect(contents).toContain(note);
  });

  test("a note saved over a PDF changed elsewhere shows the conflict and keeps the tab until the copy is saved over it", async () => {
    await openLibrary();
    await page.click(row("reading"), { count: 2 });
    const { reader, viewer } = await shownReader("reading");
    // Another window saves the PDF after this reader loaded it.
    const stored = await fetch(`${bucket.origin}/pdf/reading.pdf`);
    const tag = stored.headers.get("ETag");
    if (tag === null) {
      throw new Error("the stored PDF carries no entity tag");
    }
    const elsewhere = new Uint8Array([
      ...new Uint8Array(await stored.arrayBuffer()),
      ...new TextEncoder().encode("\n% saved in another window\n"),
    ]);
    const other = await fetch(`${bucket.origin}/api/items/reading/pdf`, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "If-Match": tag },
      body: elsewhere,
    });
    expect(other.status).toBe(200);

    await viewer.waitForFunction(
      "PDFViewerApplication.pdfViewer.annotationEditorMode !== pdfjsLib.AnnotationEditorType.DISABLE",
    );
    await viewer.evaluate(
      "PDFViewerApplication.eventBus.dispatch('switchannotationeditormode', { source: null, mode: pdfjsLib.AnnotationEditorType.FREETEXT })",
    );
    const layer = await viewer.waitForSelector(
      '.page[data-page-number="1"] .annotationEditorLayer',
    );
    const refused = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/reading/pdf") && response.request().method() === "PUT",
    );
    await layer?.click({ offset: { x: 120, y: 160 } });
    await viewer.waitForSelector(".freeTextEditor .internal");
    const note = `Written over a stale PDF ${Date.now()}`;
    await page.keyboard.type(note);
    await page.keyboard.press("Escape");
    await viewer.evaluate(
      "PDFViewerApplication.eventBus.dispatch('switchannotationeditormode', { source: null, mode: pdfjsLib.AnnotationEditorType.NONE })",
    );
    expect((await refused).status()).toBe(412);
    await reader.waitForSelector("#conflict", { visible: true });
    await shot("reader-save-conflict");

    // The tab stays while the conflict is open.
    await page.click(`${tab("reading")} button[aria-label^="Close"]`);
    await page.waitForSelector(`${tab("reading")}[data-state="active"]`);
    expect(await openTabKeys()).toContain("reading");
    // The desktop tray's Quit waits for the readers, and hears that one cannot settle.
    expect(await quitOutcome()).toBe("failed");

    const kept = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/reading/pdf") && response.request().method() === "PUT",
    );
    await reader.click("#keep-mine");
    expect((await kept).status()).toBe(200);
    await reader.waitForSelector("#conflict", { hidden: true });
    expect(await quitOutcome()).toBe("settled");
    await page.click(`${tab("reading")} button[aria-label^="Close"]`);
    await page.waitForFunction(`!document.querySelector('${tab("reading")}')`);

    await page.goto(`${bucket.origin}/read/reading`);
    const reopened = await (await page.waitForSelector("iframe"))?.contentFrame();
    if (reopened === undefined || reopened === null) {
      throw new Error("the reader has no viewer frame");
    }
    await reopened.waitForFunction("window.PDFViewerApplication?.pdfDocument?.numPages > 0");
    const contents = z
      .array(z.string())
      .parse(
        await reopened.evaluate(
          "(async () => (await (await PDFViewerApplication.pdfDocument.getPage(1)).getAnnotations()).filter((a) => a.contentsObj).map((a) => a.contentsObj.str))()",
        ),
      );
    expect(contents).toContain(note);
  });

  test("a capture made while the library is open opens its PDF in a tab", async () => {
    await openLibrary();
    const form = new FormData();
    form.set("pdf", new File([readFileSync(join(fixtures, "problem-set.pdf"))], "problems.pdf"));
    form.set("pdf_url", published("/~author/problems.pdf"));
    form.set("source_url", published("/~author/teaching.html"));
    form.set("title_hint", "Problem set on quadratic forms");
    const response = await fetch(`${bucket.origin}/capture-bytes`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    await shownReader("problems");
  });

  test("a PDF that asks for its outline opens with the outline closed, unless the setting opens it", async () => {
    const sidebarOnOpen = async () => {
      await page.goto(`${bucket.origin}/read/outlined`);
      const frame = await (await page.waitForSelector("iframe"))?.contentFrame();
      if (frame === undefined || frame === null) {
        throw new Error("the reader has no viewer frame");
      }
      // ViewsManager.setInitialView marks the sidebar state applied.
      await frame.waitForFunction(
        "PDFViewerApplication.pdfViewer?.pagesCount === 10 && PDFViewerApplication.viewsManager?.isInitialViewSet",
      );
      return z
        .tuple([z.boolean(), z.int()])
        .parse(
          await frame.evaluate(
            "[PDFViewerApplication.viewsManager.isOpen, PDFViewerApplication.viewsManager.visibleView]",
          ),
        );
    };
    expect((await sidebarOnOpen())[0]).toBe(false);
    await shot("reader-outline-closed");

    const toggle = 'button[role="switch"][aria-label="Open the outline when a PDF opens"]';
    const openSettings = async () => {
      await page.goto(`${bucket.origin}/#/settings`);
      await page.waitForSelector(toggle);
    };
    await openSettings();
    await page.click(toggle);
    await page.waitForSelector(`${toggle}[aria-checked="true"]`);
    // SidebarView.OUTLINE is 2.
    expect(await sidebarOnOpen()).toEqual([true, 2]);
    await shot("reader-outline-open");

    await openSettings();
    await page.click(toggle);
    await page.waitForSelector(`${toggle}[aria-checked="false"]`);
  });

  test("the theme follows a dark system setting until Settings chooses Light, in the library and the reader", async () => {
    // Background colours: the library's surface token (index.css) and PDF.js's --body-bg-color.
    const LIBRARY = { light: "rgb(247, 248, 250)", dark: "rgb(15, 20, 27)" };
    const VIEWER = { light: "rgb(212, 212, 215)", dark: "rgb(42, 42, 46)" };
    const themeSelect = 'select[aria-label="Theme"]';
    const libraryBackground = async () => {
      await page.goto(`${bucket.origin}/#/settings`);
      await page.waitForSelector(themeSelect);
      return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    };
    const viewerBackground = async () => {
      await page.goto(`${bucket.origin}/read/lattices`);
      const frame = await (await page.waitForSelector("iframe"))?.contentFrame();
      if (frame === undefined || frame === null) {
        throw new Error("the reader has no viewer frame");
      }
      await frame.waitForFunction("window.PDFViewerApplication?.pdfDocument?.numPages > 0");
      return frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
    };
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);

    expect(await libraryBackground()).toBe(LIBRARY.dark);
    expect(await viewerBackground()).toBe(VIEWER.dark);
    await shot("reader-dark");

    await libraryBackground();
    await page.select(themeSelect, "light");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      LIBRARY.light,
    );
    expect(await viewerBackground()).toBe(VIEWER.light);
    expect(await libraryBackground()).toBe(LIBRARY.light);

    await page.select(themeSelect, "system");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "system");
    await page.emulateMediaFeatures();
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
    // PDF.js builds its annotation editor once the first page and the document's permissions
    // have loaded, after the page count is known; until then no editor mode can be selected.
    await viewer.waitForFunction(
      "PDFViewerApplication.pdfViewer.annotationEditorMode !== pdfjsLib.AnnotationEditorType.DISABLE",
    );
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
      await frame.waitForFunction("window.PDFViewerApplication?.pdfViewer?.pagesCount === 10");
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

  test("the Timeline shows a reading session with the pages read for at least five seconds, and its title reopens the PDF in a tab", async () => {
    await page.goto(`${bucket.origin}/read/reading`);
    const viewer = await (await page.waitForSelector("iframe"))?.contentFrame();
    if (viewer === undefined || viewer === null) {
      throw new Error("the reader has no viewer frame");
    }
    await viewer.waitForFunction("window.PDFViewerApplication?.pdfViewer?.pagesCount === 10");
    // Pages 1 and 2 are read for six seconds each; page 3 is passed through at once.
    for (const pageNumber of [1, 2]) {
      await viewer.evaluate(`PDFViewerApplication.page = ${pageNumber}`);
      await Bun.sleep(6000);
    }
    await viewer.evaluate("PDFViewerApplication.page = 3");
    const reported = page.waitForResponse((response) =>
      response.url().endsWith("/api/reading-sessions"),
    );
    // The link leaves once the session is reported and every annotation saved.
    await page.click('a[aria-label="Library"]');
    expect((await reported).status()).toBe(200);
    await page.waitForSelector("nav a");

    await page.goto(`${bucket.origin}/#/timeline`);
    await page.waitForSelector('select[aria-label="Shortest reading"]');
    // Twelve seconds is under the default minimum of thirty.
    expect(await page.$('[data-timeline-key="reading"]')).toBeNull();
    await page.select('select[aria-label="Shortest reading"]', "5");
    const entry = await page.waitForSelector('[data-timeline-key="reading"]');
    expect(await entry?.evaluate((element) => element.textContent)).toContain("pp. 1–2");
    await shot("timeline");
    await page.click('[data-timeline-key="reading"] a');
    await shownReader("reading");
    expect(new URL(page.url()).hash).toBe("#/timeline");
  });

  test("the grid view shows each PDF's first page, and a double-click opens the reader in a tab", async () => {
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
    await shownReader("reading");

    // The layout is kept for the next visit; the list comes back only when chosen.
    await openRoot();
    await page.waitForSelector('[data-card-id="reading"]');
    await page.click('button[aria-label="List view"]');
    await page.waitForSelector(row("reading"));
  });

  test("rows chosen with their checkboxes are tagged and filed together", async () => {
    await openLibrary();
    const chosen = ["problems", "lattices"];
    for (const key of chosen) {
      await page.click(`${row(key)} input[type="checkbox"]`);
    }
    await page.waitForSelector("::-p-text(2 selected)");
    await shot("library-selection");

    await page.click('button[aria-label="Tag selected"]');
    await page.type('[role="dialog"] input', "survey");
    await page.keyboard.press("Enter");
    for (const key of chosen) {
      await shows(row(key), "survey");
    }
    await page.click('button[aria-label="File selected"]');
    const filed = page.waitForResponse((response) =>
      response.url().endsWith("/api/bulk/collections"),
    );
    await (await menuItem("Quadratic forms")).click();
    expect((await filed).status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('[role="menu"]') === null);

    const org = await organization();
    const forms = org.collections.find((collection) => collection.name === "Quadratic forms");
    for (const key of chosen) {
      expect(org.items[key]?.tags).toContain("survey");
      expect(org.items[key]?.collections).toContain(forms?.id ?? "");
    }
    expect(org.items.reading?.tags ?? []).not.toContain("survey");
    await page.click('button[aria-label="Clear selection"]');
    await page.waitForFunction(() => !document.body.textContent?.includes("selected"));
  });

  test("Import URL and Add Folder in the toolbar add PDFs to the library", async () => {
    served.set(
      "/~author/imported.pdf",
      new Uint8Array(readFileSync(join(fixtures, "long-notes.pdf"))),
    );
    await openLibrary();
    await page.click('button[aria-label="Import URL"]');
    await page.type('[role="dialog"] input', published("/~author/imported.pdf"));
    await shot("dialog-import-url");
    await page.keyboard.press("Enter");
    await page.waitForSelector(row("imported"));
    // The dialog closes once the server has accepted the URL.
    await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);

    const folder = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-folder-"));
    // A PDF the library does not hold yet: the problem set with a comment after its end.
    writeFileSync(
      join(folder, "folder notes.pdf"),
      new Uint8Array([
        ...fixture("problem-set.pdf"),
        ...new TextEncoder().encode("% the folder copy\n"),
      ]),
    );
    await page.click('button[aria-label="Add Folder"]');
    await page.type('[role="dialog"] input', folder);
    await page.keyboard.press("Enter");
    await page.waitForSelector(row("folder notes"));
    await shot("library-imported");
    const payload = LibraryPayloadSchema.parse(
      await (await fetch(`${bucket.origin}/api/library`)).json(),
    );
    const added = payload.items.find((item) => item.id === "folder notes");
    expect(added?.provenance.pdf_url).toBe(pathToFileURL(join(folder, "folder notes.pdf")).href);
  });

  test("the Related tab lists the PDFs that share authors, collections, topics or tags with the selected one", async () => {
    await openLibrary();
    const org = await organization();
    const filing = (key: string) => [
      ...(org.items[key]?.collections ?? []),
      ...(org.items[key]?.tags ?? []),
    ];
    const sharing = Object.keys(org.items).filter(
      (key) =>
        key !== "problems" && filing(key).some((entry) => filing("problems").includes(entry)),
    );
    expect(sharing.length).toBeGreaterThan(0);

    await page.click(row("problems"));
    await (await byRole("tab", `Related (${sharing.length})`)).click();
    await shot("details-related");
    const related = await page.$$eval("[data-related-id]", (entries) =>
      entries.map((entry) => entry.getAttribute("data-related-id")),
    );
    expect([...related].sort()).toEqual([...sharing].sort());

    await page.click(`[data-related-id="${sharing[0]}"]`);
    await page.waitForSelector(`${row(sharing[0] ?? "")}[aria-selected="true"]`);
  });

  test("an unsent note outlives a tab switch and another selection; a note is deleted only once confirmed", async () => {
    await openLibrary();
    await page.click(row("outlined"));
    await (await byRole("tab", "Notes")).click();
    const draft = "Compare the outline with chapter 3";
    await page.type('textarea[aria-label="New note"]', draft);
    await (await byRole("tab", "Details")).click();
    await page.click(row("lattices"));
    await page.click(row("outlined"));
    await (await byRole("tab", "Notes")).click();
    const kept = await page.$eval('textarea[aria-label="New note"]', (field) => field.value);
    expect(kept).toBe(draft);

    await (await byRole("button", "Add note")).click();
    await shows("aside article", draft);
    expect(await page.$eval('textarea[aria-label="New note"]', (field) => field.value)).toBe("");
    expect((await organization()).items.outlined?.notes.map((note) => note.note)).toEqual([draft]);

    await page.click('button[aria-label="Delete note"]');
    await shot("note-delete-confirm");
    await (await byRole("button", "Cancel")).click();
    expect((await organization()).items.outlined?.notes).toHaveLength(1);
    await page.click('button[aria-label="Delete note"]');
    await (await byRole("button", "Delete note")).click();
    await page.waitForFunction(() => document.querySelector("aside article") === null);
    expect((await organization()).items.outlined?.notes).toEqual([]);
  });

  test("a tag added by another window shows in the open library without a reload", async () => {
    await openLibrary();
    const response = await fetch(`${bucket.origin}/api/bulk/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: ["outlined"],
        add: ["from elsewhere"],
        remove: [],
      }),
    });
    expect(response.status).toBe(200);
    await shows(row("outlined"), "from elsewhere");
  });

  test("collection cards show counts and pins; a collection keeps a description, Keep offline and its activity; New Topic tags the chosen rows", async () => {
    const cards = () =>
      page.$$eval("[data-collection-id]", (entries) =>
        entries.map((entry) => entry.getAttribute("data-collection-name")),
      );
    await page.goto(`${bucket.origin}/#/organization/collections`);
    await page.waitForSelector("[data-collection-id]");
    const org = await organization();
    const forms = org.collections.find((collection) => collection.name === "Quadratic forms");
    if (forms === undefined) {
      throw new Error("no Quadratic forms collection");
    }
    const held = Object.values(org.items).filter((filing) => filing.collections.includes(forms.id));
    const card = `[data-collection-id="${forms.id}"]`;
    expect(await page.$eval(card, (entry) => entry.textContent)).toContain(`${held.length} PDFs`);
    const unpinned = await cards();
    await page.click(`${card} button[aria-label="Pin"]`);
    await page.waitForSelector(`${card} button[aria-label="Unpin"]`);
    expect((await cards())[0]).toBe("Quadratic forms");
    expect(unpinned[0]).not.toBe("Quadratic forms");
    await shot("collections-cards");

    await page.click(card);
    await page.waitForFunction(
      (id) => location.hash === `#/organization/collections/${id}`,
      {},
      forms.id,
    );
    await page.click('button[aria-label="Edit description"]');
    await page.type('[role="dialog"] input', "Genus theory and the Hasse–Minkowski theorem");
    await page.keyboard.press("Enter");
    await shows("main", "Genus theory and the Hasse–Minkowski theorem");
    await page.click('button[role="switch"][aria-label="Keep offline"]');
    await page.waitForSelector(
      'button[role="switch"][aria-label="Keep offline"][aria-checked="true"]',
    );
    await page.waitForSelector("::-p-text(Kept offline)");

    const chosen = Object.keys(org.items).find((key) =>
      org.items[key]?.collections.includes(forms.id),
    );
    if (chosen === undefined) {
      throw new Error("Quadratic forms holds no PDF");
    }
    await page.click(`${row(chosen)} input[type="checkbox"]`);
    await page.click('button[aria-label="New Topic"]');
    await page.type('[role="dialog"] input', "Genus theory");
    await page.keyboard.press("Enter");
    await shows(row(chosen), "Genus theory");
    await shot("collection-page");

    const after = await organization();
    const saved = after.collections.find((collection) => collection.id === forms.id);
    expect([saved?.description, saved?.pinned, saved?.keepOffline]).toEqual([
      "Genus theory and the Hasse–Minkowski theorem",
      true,
      true,
    ]);
    expect(after.items[chosen]?.tags).toContain("topic:Genus theory");
    await page.click('button[aria-label="Clear selection"]');

    // An emptied description clears it.
    await page.click('button[aria-label="Edit description"]');
    await page.click('[role="dialog"] input', { count: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await shows("main", "No description");
    const cleared = (await organization()).collections.find(
      (collection) => collection.id === forms.id,
    );
    expect(cleared?.description).toBe("");
  });

  test("a smart collection built from rules lists the PDFs meeting all of them, and after an edit any of them", async () => {
    const payload = LibraryPayloadSchema.parse(
      await (await fetch(`${bucket.origin}/api/library`)).json(),
    );
    const forms = payload.collections.find((collection) => collection.name === "Quadratic forms");
    if (forms === undefined) {
      throw new Error("no Quadratic forms collection");
    }
    const inForms = (item: BucketItem) => item.collections.includes(forms.id);
    const unread = (item: BucketItem) => item.reading.status === "unread";
    const keys = (keep: (item: BucketItem) => boolean) =>
      payload.items
        .filter(keep)
        .map((item) => item.id)
        .sort();
    const both = keys((item) => inForms(item) && unread(item));
    const either = keys((item) => inForms(item) || unread(item));
    // The two readings must differ, or the edit would prove nothing.
    expect(either.length).toBeGreaterThan(both.length);

    await page.goto(`${bucket.origin}/#/organization/saved`);
    await page.click('button[aria-label="Smart Collection"]');
    await page.type('[role="dialog"] input[aria-label="Name"]', "Unread quadratic forms");
    await page.select('[role="dialog"] select[aria-label="Rule 1 field"]', "collection");
    await page.select('[role="dialog"] select[aria-label="Rule 1 value"]', forms.id);
    await page.click('[role="dialog"] button[aria-label="Add rule"]');
    await page.select('[role="dialog"] select[aria-label="Rule 2 field"]', "reading");
    await page.select('[role="dialog"] select[aria-label="Rule 2 value"]', "unread");
    await shot("dialog-smart-collection");
    await page.click('[role="dialog"] button[type="submit"]');
    await page.waitForFunction(() => location.hash.startsWith("#/organization/saved/"));
    const rowsNow = async (count: number) => {
      await page.waitForFunction(
        (wanted) => document.querySelectorAll("tr[data-item-id]").length === wanted,
        {},
        count,
      );
      return (await rowKeys()).sort();
    };
    expect(await rowsNow(both.length)).toEqual(both);
    await shot("smart-collection");

    await page.click('button[aria-label="Edit rules"]');
    await page.select('[role="dialog"] select[aria-label="Match"]', "any");
    await page.click('[role="dialog"] button[type="submit"]');
    expect(await rowsNow(either.length)).toEqual(either);
  });

  test("an action run while the bucket is down says the bucket did not answer", async () => {
    const downed = await startBucket();
    await page.goto(`${downed.origin}/`);
    await page.waitForSelector(row("lattices"));
    await downed.stop();
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("p");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await page.keyboard.type("Verify All Sources");
    await page.keyboard.press("Enter");
    await shows('[role="alert"] strong', "The bucket did not answer");
    await shot("action-bucket-down");
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
    // The mirror's link in the sources list; a text match would also find the URL still in the
    // field it was typed into, before the server's answer adds the line.
    await page.waitForSelector(
      `${details} li a[href="${published("/~author/mirror/problems.pdf")}"]`,
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
