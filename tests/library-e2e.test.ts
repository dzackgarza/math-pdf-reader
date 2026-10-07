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
import type { AnnotationPlugin, EmbedPdfContainer, ScrollPlugin } from "@embedpdf/react-pdf-viewer";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { build } from "vite";
import { z } from "zod";
import { CaptureResponseSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { type BucketItem, LibraryPayloadSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";
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
    indexExport,
  });
  const origin = app.origin;
  for (const [key, bytes, linkText] of CAPTURES) {
    const form = new FormData();
    form.set("pdf", new File([bytes], `${key}.pdf`));
    form.set("pdf_url", published(`/~author/${key}.pdf`));
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
  // The reader of KEY, in a tab or on its own page, and the EmbedPDF viewer in it, whose UI is in
  // the viewer's shadow root (puppeteer's `>>>` reaches into it).
  const readerOf = (key: string) => `[data-reader-key="${key}"]`;
  const viewerOf = (key: string) => `${readerOf(key)} embedpdf-container`;
  const inViewer = (key: string, css: string) => `${viewerOf(key)} >>> ${css}`;
  // A page of the PDF: EmbedPDF draws each in a white box (its snippet's renderPage).
  const PAGE_BOX = 'div[style*="transform-origin"][style*="background-color"]';
  const openTabKeys = () =>
    page.$$eval("[data-tab-key]", (tabs) =>
      tabs.map((element) => element.getAttribute("data-tab-key")),
    );
  // The keys of the readers loaded in the window.
  const readerKeys = async () =>
    (
      await page.$$eval("[data-reader-key]", (readers) =>
        readers.map((reader) => reader.getAttribute("data-reader-key")),
      )
    ).sort();
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
  // Waits until KEY's reader has drawn a page of its PDF, as an image in a page box.
  const readerLoaded = (key: string) =>
    page.waitForFunction(
      (css, box) =>
        [...(document.querySelector(css)?.shadowRoot?.querySelectorAll(`${box} img`) ?? [])].some(
          (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
        ),
      {},
      viewerOf(key),
      PAGE_BOX,
    );
  // The page KEY's reader shows, as its page box below the PDF reads.
  const pageInput = (key: string) => inViewer(key, '[data-epdf-i="page-controls"] input');
  const showsPage = (key: string, pageNumber: number) =>
    page.waitForFunction(
      (css, wanted) => {
        const input = document
          .querySelector(css)
          ?.shadowRoot?.querySelector('[data-epdf-i="page-controls"] input');
        return input instanceof HTMLInputElement && input.value === wanted;
      },
      {},
      viewerOf(key),
      String(pageNumber),
    );
  // Goes to a page of KEY's PDF as a reader does: typed into the page box.
  const goToPage = async (key: string, pageNumber: number) => {
    await page.click(pageInput(key), { count: 3 });
    await page.keyboard.type(String(pageNumber));
    await page.keyboard.press("Enter");
    await showsPage(key, pageNumber);
  };
  // The top left corner of page 1 of KEY's PDF, once the reader shows it. The scroll goes
  // through EmbedPDF itself: its page box is absent from a PDF of one page. EmbedPDF draws only
  // the pages near the one shown, so page 1 is the highest page drawn once its top is in the
  // window, and a page above the window is still on the way to it.
  const firstPageCorner = async (key: string) => {
    await page.evaluate(async (css) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const scroll = (await viewer?.registry)?.getPlugin<ScrollPlugin>("scroll")?.provides();
      if (scroll === undefined) {
        throw new Error(`${css} has no scroll plugin`);
      }
      scroll.scrollToPage({ pageNumber: 1, behavior: "instant" });
    }, viewerOf(key));
    const corner = await page.waitForFunction(
      (css, box) => {
        const tops = [...(document.querySelector(css)?.shadowRoot?.querySelectorAll(box) ?? [])]
          .map((element) => element.getBoundingClientRect())
          .sort((one, other) => one.y - other.y);
        const first = tops[0];
        return first !== undefined && first.y >= 0 && { x: first.x, y: first.y };
      },
      {},
      viewerOf(key),
      PAGE_BOX,
    );
    return z.object({ x: z.number(), y: z.number() }).parse(await corner.jsonValue());
  };
  // Writes NOTE on page 1 of KEY's PDF with EmbedPDF's free-text tool, from its Annotate toolbar.
  const writeNote = async (key: string, note: string) => {
    // The Annotate toolbar opens below the main one and moves the pages down, so the page's
    // corner is found once it is open.
    await page.click(inViewer(key, '[data-epdf-i="annotate-mode"] button'));
    await page.click(inViewer(key, '[data-epdf-i="add-text"] button'));
    const corner = await firstPageCorner(key);
    await page.mouse.click(corner.x + 120, corner.y + 160);
    await page.waitForSelector(inViewer(key, '[contenteditable="true"]'));
    await page.keyboard.type(note);
    await page.keyboard.press("Escape");
  };
  // The contents of the annotations on page 1 of KEY's PDF, as its reader reads them from the
  // stored file.
  const notesOnFirstPage = async (key: string) => {
    await readerLoaded(key);
    return z.array(z.string()).parse(
      await page.evaluate(async (css) => {
        const viewer = document.querySelector<EmbedPdfContainer>(css);
        const annotations = (await viewer?.registry)
          ?.getPlugin<AnnotationPlugin>("annotation")
          ?.provides();
        if (annotations === undefined) {
          throw new Error(`${css} has no annotation plugin`);
        }
        return (await annotations.getPageAnnotations({ pageIndex: 0 }).toPromise()).flatMap(
          (annotation) => (annotation.contents === undefined ? [] : [annotation.contents]),
        );
      }, viewerOf(key)),
    );
  };
  // The tab for KEY, once it is the tab shown and its reader has drawn the PDF.
  const shownReader = async (key: string) => {
    await page.waitForSelector(`${tab(key)}[data-state="active"]`);
    await page.waitForSelector(readerOf(key), { visible: true });
    await readerLoaded(key);
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

  test("an item deleted elsewhere while its row menu is open closes the menu and leaves the library", async () => {
    const form = new FormData();
    const bytes = new Uint8Array([
      ...fixture("problem-set.pdf"),
      ...new TextEncoder().encode("% deleted while its menu is open\n"),
    ]);
    form.set("pdf", new File([bytes], "menu-open.pdf"));
    form.set("pdf_url", published("/~author/menu-open.pdf"));
    form.set("title_hint", "Deleted while its menu is open");
    const response = await fetch(`${bucket.origin}/capture-bytes`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    const { key } = CaptureResponseSchema.parse(await response.json());
    await openLibrary();
    await page.click(row(key), { button: "right" });
    await menuItem("Guess Metadata");

    const deleted = await fetch(`${bucket.origin}/api/items/${key}`, { method: "DELETE" });
    expect(deleted.ok).toBe(true);
    await page.waitForFunction(
      (selector) => document.querySelector(selector) === null,
      {},
      row(key),
    );

    expect(await page.evaluate(() => document.body.innerText)).not.toContain(
      "The library failed to render",
    );
    expect(await page.$('[role="menu"]')).toBeNull();
    expect(await rowKeys()).toContain("lattices");
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

  test("Delete and Enter on a focused button act on that button, not on the selected PDF", async () => {
    await openLibrary();
    await page.click(row("lattices"));
    await page.waitForSelector(`${row("lattices")}[aria-selected="true"]`);
    const tabsBefore = await openTabKeys();
    const unfiled = 'button[aria-label="Unfiled"]';
    await page.focus(unfiled);

    await page.keyboard.press("Delete");
    expect(await page.$('[role="alertdialog"], [role="dialog"]')).toBeNull();
    await page.keyboard.press("Enter");
    expect(await page.$eval(unfiled, (button) => button.getAttribute("aria-pressed"))).toBe("true");
    expect(await openTabKeys()).toEqual(tabsBefore);

    await page.keyboard.press("Enter");
    await page.waitForSelector(`${unfiled}[aria-pressed="false"]`);
  });

  test("reader back and forward walk the positions visited in the PDF and stay in it; on its own, the reader's Library returns to the view the library last showed", async () => {
    await page.goto(`${bucket.origin}/#/unfiled`);
    await page.waitForSelector(row("reading"));
    await page.goto(`${bucket.origin}/read/reading#page=1`);
    await readerLoaded("reading");
    // A page typed into the page box is a jump, as a link or an outline entry is; the reader's
    // address names the page it shows.
    for (const pageNumber of [7, 3]) {
      await goToPage("reading", pageNumber);
      await page.waitForFunction((n) => location.hash === `#page=${n}`, {}, pageNumber);
    }
    await shot("reader");

    const back = 'button[aria-label="Back"]';
    const forward = 'button[aria-label="Forward"]';
    await page.click(back);
    await showsPage("reading", 7);
    await page.click(back);
    await showsPage("reading", 1);
    expect(await page.$eval(back, (button) => (button as HTMLButtonElement).disabled)).toBe(true);
    await page.keyboard.down("Alt");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Alt");
    expect(new URL(page.url()).pathname).toBe("/read/reading");
    await showsPage("reading", 1);
    await page.keyboard.down("Alt");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Alt");
    await showsPage("reading", 7);
    await page.click(back);
    await showsPage("reading", 1);
    await page.click(forward);
    await showsPage("reading", 7);
    await page.waitForFunction(() => location.hash === "#page=7");
    const address = page.url();

    await page.click('a[aria-label="Library"]');
    await page.waitForSelector(row("reading"));
    expect(new URL(page.url()).hash).toBe("#/unfiled");

    await page.goto(address);
    await readerLoaded("reading");
    await showsPage("reading", 7);
    await page.setViewport({ width: 700, height: 900 });
    await shot("reader-narrow");
    await page.setViewport(viewport);
  });

  test("the reader link button copies the captured PDF URL", async () => {
    await page.goto(`${bucket.origin}/read/lattices`);
    await readerLoaded("lattices");
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
    // Loaded while hidden, the PDF has drawn its pages when its tab is shown.
    await readerLoaded("problems");
    // The Library tab has focus and answers Enter itself; the row takes it back.
    await page.click(row("problems"));
    await page.keyboard.press("Enter");
    await shownReader("problems");
    expect(await openTabKeys()).toEqual(["problems"]);
    expect(await page.$eval(tab("problems"), (element) => element.textContent)).toBe(
      titleOf("problems"),
    );
    // The tab strip holds the way back, so the reader in a tab shows no Library link.
    expect(await page.$(`${readerOf("problems")} a[aria-label="Library"]`)).toBeNull();
    await shot("tabs-reader");

    await (await byRole("tab", "Library")).click();
    await page.click(row("reading"));
    await page.keyboard.press("Enter");
    await shownReader("reading");
    expect(await openTabKeys()).toEqual(["problems", "reading"]);
    await shot("tabs-two");

    // Keys pressed while reading reach the tab strip from inside the PDF.
    await page.click(inViewer("reading", PAGE_BOX));
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

  test("past five PDF tabs the one shown longest ago sleeps, holding no reader, and wakes at its page when shown; Sleep Tab in a tab's menu puts that tab to sleep, showing the tab to its right in place of the one shown", async () => {
    // The test opens and deletes its own PDFs, so later tests see the fixtures as they were.
    const captureTab = async (source: string, ordinal: string) => {
      const form = new FormData();
      const bytes = new Uint8Array([
        ...fixture(source),
        ...new TextEncoder().encode(`% the ${ordinal} tab\n`),
      ]);
      form.set("pdf", new File([bytes], `${ordinal}-tab.pdf`));
      form.set("pdf_url", published(`/~author/${ordinal}-tab.pdf`));
      form.set("title_hint", `The ${ordinal} tab`);
      const response = await fetch(`${bucket.origin}/capture-bytes`, {
        method: "POST",
        body: form,
      });
      expect(response.status).toBe(200);
      return CaptureResponseSchema.parse(await response.json()).key;
    };
    const [first, ...later] = await Promise.all([
      captureTab("long-notes.pdf", "first"),
      ...["second", "third", "fourth", "fifth", "sixth"].map((ordinal) =>
        captureTab("problem-set.pdf", ordinal),
      ),
    ]);
    const [second, third] = later;
    const asleep = (key: string) => page.waitForSelector(`${tab(key)}[data-asleep="true"]`);

    await openLibrary();
    await page.click(row(first), { count: 2 });
    await shownReader(first);
    await goToPage(first, 3);
    for (const key of later) {
      await (await byRole("tab", "Library")).click();
      await page.click(row(key));
      await page.keyboard.press("Enter");
      await shownReader(key);
    }
    await asleep(first);
    expect(await readerKeys()).toEqual([...later].sort());
    await shot("tabs-asleep");

    await page.click(`${tab(first)} [role="tab"]`);
    await shownReader(first);
    await showsPage(first, 3);
    await asleep(second);
    expect(await readerKeys()).not.toContain(second);

    await page.click(tab(third), { button: "right" });
    await (await menuItem("Sleep Tab")).click();
    await asleep(third);
    expect(await readerKeys()).not.toContain(third);

    await page.click(tab(first), { button: "right" });
    await (await menuItem("Sleep Tab")).click();
    await asleep(first);
    await shownReader(second);
    expect(await readerKeys()).toEqual(later.filter((key) => key !== third).sort());

    for (const key of [first, ...later]) {
      const deleted = await fetch(`${bucket.origin}/api/items/${key}`, { method: "DELETE" });
      expect(deleted.ok).toBe(true);
    }
  }, 60_000);

  test("closing a PDF's tab right after a note is written saves the note into the PDF first", async () => {
    await openLibrary();
    await page.click(row("outlined"), { count: 2 });
    await shownReader("outlined");
    const note = `Closed at once ${Date.now()}`;
    await writeNote("outlined", note);
    await page.click(`${tab("outlined")} button[aria-label^="Close"]`);
    await page.waitForSelector(row("outlined"), { visible: true });
    expect(await openTabKeys()).toEqual([]);

    await page.goto(`${bucket.origin}/read/outlined`);
    expect(await notesOnFirstPage("outlined")).toContain(note);
  });

  test("a note saved over a PDF changed elsewhere shows the conflict and keeps the tab until the copy is saved over it", async () => {
    await openLibrary();
    await page.click(row("reading"), { count: 2 });
    await shownReader("reading");
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

    const refused = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/reading/pdf") && response.request().method() === "PUT",
    );
    const note = `Written over a stale PDF ${Date.now()}`;
    await writeNote("reading", note);
    expect((await refused).status()).toBe(412);
    const conflict = `${readerOf("reading")} [role="alert"]`;
    await page.waitForSelector(conflict, { visible: true });
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
    await page.click(`${conflict} button::-p-text(Save my copy over it)`);
    expect((await kept).status()).toBe(200);
    await page.waitForSelector(conflict, { hidden: true });
    expect(await quitOutcome()).toBe("settled");
    await page.click(`${tab("reading")} button[aria-label^="Close"]`);
    await page.waitForFunction(`!document.querySelector('${tab("reading")}')`);

    await page.goto(`${bucket.origin}/read/reading`);
    expect(await notesOnFirstPage("reading")).toContain(note);
  });

  test("a capture made while the library is open opens its PDF in a tab", async () => {
    await openLibrary();
    const form = new FormData();
    form.set("pdf", new File([readFileSync(join(fixtures, "problem-set.pdf"))], "problems.pdf"));
    form.set("pdf_url", published("/~author/problems.pdf"));
    form.set("title_hint", "Problem set on quadratic forms");
    const response = await fetch(`${bucket.origin}/capture-bytes`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    await shownReader("problems");
  });

  test("the status bar shows Zotero's state; a capture's reader opened before Retrieve metadata answers takes the title it resolves, in its tab and on its own page, and a source nothing identifies shows why", async () => {
    // Zotero identifies the arXiv URL, once the test lets it answer; no method identifies any
    // other URL. The PDF captured there has no title of its own, so it opens under its hint.
    const arxivPdf = "https://arxiv.org/pdf/2609.21174v1";
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const zotero = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const headers = { "Content-Type": "application/json" };
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname === "/version") {
          return new Response(readFileSync(join(fixtures, "zotero/version.json")), { headers });
        }
        const { url } = z
          .strictObject({ operation: z.literal("resolve_url"), url: z.url() })
          .parse(await request.json());
        if (url === arxivPdf) {
          await answered;
          return new Response(readFileSync(join(fixtures, "zotero/resolve-arxiv.json")), {
            headers,
          });
        }
        return new Response(readFileSync(join(fixtures, "zotero/resolve-unidentified.json")), {
          status: 422,
          headers,
        });
      },
    });
    const app = await serveBucket({
      root: mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-zotero-")),
      zoteroUrl: zotero.url.origin,
      extractionsManifest: EXTRACTIONS_MANIFEST,
    });
    const capture = async (file: string, pdfUrl: string, titleHint: string) => {
      const form = new FormData();
      form.set("pdf", new File([fixture(file)], file));
      form.set("pdf_url", pdfUrl);
      form.set("title_hint", titleHint);
      const response = await app.request("/capture-bytes", { method: "POST", body: form });
      expect(response.status).toBe(200);
      return CaptureResponseSchema.parse(await response.json()).key;
    };
    // A new page comes to the front, and Chromium draws no frames for a page behind it: the
    // library goes back to the front, so the reader in its tab draws the PDF.
    const own = await browser.newPage();
    await page.bringToFront();
    try {
      await page.goto(`${app.origin}/`);
      await page.waitForSelector(
        '[role="status"][aria-label="Zotero is running with its local write API 3.4.0"]',
      );

      const key = await capture("lecture-notes.pdf", arxivPdf, "View PDF");
      await shownReader(key);
      expect(await page.$eval(tab(key), (element) => element.textContent)).toContain("View PDF");
      // The same PDF on its own reader page, whose title and citation tags a Zotero Connector
      // reads.
      await own.goto(`${app.origin}/read/${key}`);
      await own.waitForSelector(`${readerOf(key)} h1`);
      answer();
      const title = "On The Cyclicity of Algebraic Lattices";
      await shows(tab(key), title);
      await shows(`${readerOf(key)} h1`, title);
      await own.waitForFunction(
        (wanted) =>
          document.querySelector('meta[name="citation_title"]')?.getAttribute("content") ===
            wanted &&
          document.title === wanted &&
          document.querySelector("header h1")?.textContent === wanted,
        {},
        title,
      );
      await shot("zotero-retitled-reader");

      await capture("problem-set.pdf", published("/~author/problems.pdf"), "Problem set");
      await shows('[role="alert"]', "Retrieve metadata for ");
      await shot("zotero-unidentified");

      zotero.stop(true);
      await page.waitForSelector(
        '[role="status"][aria-label="Zotero is not running: start Zotero"]',
      );
      await shot("zotero-not-running");
    } finally {
      await own.close();
      zotero.stop(true);
      await app.stop();
    }
  });

  test("a PDF that asks for its outline opens with the outline closed, unless the setting opens it", async () => {
    // Whether EmbedPDF's sidebar shows an entry of the outline, whose entries are the section
    // titles of outlined-notes.pdf. EmbedPDF draws the page's own text into images, not elements.
    const outlineShown = (css: string) =>
      [...(document.querySelector(css)?.shadowRoot?.querySelectorAll("span") ?? [])].some(
        (entry) => entry.textContent === "Gram matrices" && entry.checkVisibility(),
      );
    const openOutlined = async () => {
      await page.goto(`${bucket.origin}/read/outlined`);
      await readerLoaded("outlined");
    };
    await openOutlined();
    expect(await page.evaluate(outlineShown, viewerOf("outlined"))).toBe(false);
    await shot("reader-outline-closed");

    const toggle = 'button[role="switch"][aria-label="Open the outline when a PDF opens"]';
    const openSettings = async () => {
      await page.goto(`${bucket.origin}/#/settings`);
      await page.waitForSelector(toggle);
    };
    await openSettings();
    await page.click(toggle);
    await page.waitForSelector(`${toggle}[aria-checked="true"]`);
    await openOutlined();
    await page.waitForFunction(outlineShown, {}, viewerOf("outlined"));
    await shot("reader-outline-open");

    await openSettings();
    await page.click(toggle);
    await page.waitForSelector(`${toggle}[aria-checked="false"]`);
  });

  test("the theme follows a dark system setting until Settings chooses Light, in the library and the reader", async () => {
    // The library's surface token (index.css) as its background, and EmbedPDF's colour scheme.
    const LIBRARY = { light: "rgb(247, 248, 250)", dark: "rgb(15, 20, 27)" };
    const themeSelect = 'select[aria-label="Theme"]';
    const libraryBackground = async () => {
      await page.goto(`${bucket.origin}/#/settings`);
      await page.waitForSelector(themeSelect);
      return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    };
    const viewerScheme = async () => {
      await page.goto(`${bucket.origin}/read/lattices`);
      await readerLoaded("lattices");
      return page.evaluate((css) => {
        const viewer = document.querySelector<EmbedPdfContainer>(css);
        if (viewer === null) {
          throw new Error(`no ${css}`);
        }
        return viewer.activeColorScheme;
      }, viewerOf("lattices"));
    };
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);

    expect(await libraryBackground()).toBe(LIBRARY.dark);
    expect(await viewerScheme()).toBe("dark");
    await shot("reader-dark");

    await libraryBackground();
    await page.select(themeSelect, "light");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      LIBRARY.light,
    );
    expect(await viewerScheme()).toBe("light");
    expect(await libraryBackground()).toBe(LIBRARY.light);

    await page.select(themeSelect, "system");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "system");
    await page.emulateMediaFeatures();
  });

  test("night mode in the reader draws the PDF's pages light on dark, and turns off again", async () => {
    // The colour of the window's pixel at POINT, as a screenshot shows it.
    const pixelAt = async (point: { x: number; y: number }) => {
      const png = await page.screenshot({
        clip: { x: point.x, y: point.y, width: 1, height: 1 },
        encoding: "base64",
      });
      return z.array(z.int()).parse(
        await page.evaluate(async (data) => {
          const image = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${data}`)).blob(),
          );
          const context = new OffscreenCanvas(1, 1).getContext("2d");
          if (context === null) {
            throw new Error("no 2d canvas");
          }
          context.drawImage(image, 0, 0);
          return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        }, png),
      );
    };
    // A point in the white margin of page 1.
    const margin = async () => {
      await readerLoaded("lattices");
      const corner = await firstPageCorner("lattices");
      return { x: corner.x + 4, y: corner.y + 4 };
    };
    const nightMode = 'button[aria-label="Night mode"]';
    const toggleNightMode = async (pressed: boolean) => {
      await page.click(nightMode);
      await page.waitForSelector(`${nightMode}[aria-pressed="${pressed}"]`);
    };
    await page.goto(`${bucket.origin}/read/lattices`);
    expect(await pixelAt(await margin())).toEqual([255, 255, 255]);

    await toggleNightMode(true);
    expect(await pixelAt(await margin())).toEqual([0, 0, 0]);
    expect((await organization()).preferences.readerNightMode).toBe(true);
    await shot("reader-night-mode");
    // A reader opened later reads in night mode too.
    await page.reload();
    expect(await pixelAt(await margin())).toEqual([0, 0, 0]);

    await toggleNightMode(false);
    expect(await pixelAt(await margin())).toEqual([255, 255, 255]);
    expect((await organization()).preferences.readerNightMode).toBe(false);
  });

  test("a text note written on a page in the reader is saved into the PDF and is there after a reload", async () => {
    await page.goto(`${bucket.origin}/read/problems`);
    await readerLoaded("problems");
    const note = `Checked the Hasse–Minkowski step ${Date.now()}`;
    await writeNote("problems", note);
    await shot("reader-annotated");
    // The reader's Library link leaves once every annotation is saved.
    await page.click('a[aria-label="Library"]');
    await page.waitForSelector("nav a");

    await page.goto(`${bucket.origin}/read/problems`);
    expect(await notesOnFirstPage("problems")).toContain(note);
  });

  test("the reader records the last viewed page, the library shows it out of the page count, and the reader reopens there", async () => {
    await page.goto(`${bucket.origin}/read/reading`);
    await readerLoaded("reading");
    const recorded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/reading/reading") &&
        response.request().postData() === JSON.stringify({ page: 4, pages: 10 }),
    );
    await goToPage("reading", 4);
    expect((await recorded).status()).toBe(200);

    await openLibrary();
    expect(await page.$eval(`${row("reading")} [data-reading]`, (cell) => cell.textContent)).toBe(
      "4 / 10",
    );
    expect(await page.$eval(`${row("lattices")} [data-reading]`, (cell) => cell.textContent)).toBe(
      "Unread",
    );
    await shot("library-reading");

    await page.goto(`${bucket.origin}/read/reading`);
    await readerLoaded("reading");
    await showsPage("reading", 4);
  });

  test("the Timeline shows a reading session with the pages read for at least five seconds, and its title reopens the PDF in a tab", async () => {
    await page.goto(`${bucket.origin}/read/reading`);
    await readerLoaded("reading");
    // Pages 1 and 2 are read for six seconds each; page 3 is passed through at once.
    for (const pageNumber of [1, 2]) {
      await goToPage("reading", pageNumber);
      await Bun.sleep(6000);
    }
    await goToPage("reading", 3);
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

  test("Guess Metadata in the menu of a row outside the checked rows guesses that row; in a checked row, every checked row", async () => {
    // The browser answers each guess itself, so no model provider is reached; the keys guessed
    // are the ones the library asked for.
    const guessed: string[] = [];
    const answerGuess = (request: HTTPRequest) => {
      const guess = /^\/api\/items\/([^/]+)\/guess-metadata$/.exec(new URL(request.url()).pathname);
      if (guess === null) {
        void request.continue();
        return;
      }
      guessed.push(decodeURIComponent(guess[1] ?? ""));
      void request.respond({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: { kind: "metadata_guess_failed", message: "no model answers in this test" },
        }),
      });
    };
    const guessFrom = async (key: string) => {
      guessed.length = 0;
      await page.click(row(key), { button: "right" });
      await (await menuItem("Guess Metadata")).click();
      // The action reports once every guess it asked for has answered.
      await shows('[role="alert"]', "no model answers in this test");
      await (await byRole("button", "Dismiss")).click();
      return [...guessed];
    };
    await openLibrary();
    await page.setRequestInterception(true);
    page.on("request", answerGuess);
    try {
      for (const key of ["problems", "lattices"]) {
        await page.click(`${row(key)} input[type="checkbox"]`);
      }
      await page.waitForSelector("::-p-text(2 selected)");

      expect(await guessFrom("reading")).toEqual(["reading"]);
      expect((await guessFrom("problems")).sort()).toEqual(["lattices", "problems"]);
    } finally {
      page.off("request", answerGuess);
      await page.setRequestInterception(false);
    }
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

  test("an extraction past its time limit shows the limit and that nothing was written", async () => {
    const config = loadAppConfig(CONFIG_PATH);
    const manifest = join(
      mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-manifest-")),
      "extractions.json",
    );
    writeFileSync(
      manifest,
      JSON.stringify({
        plugins: [
          {
            id: "hang",
            name: "Slow extractor",
            command: ["sh", join(fixtures, "plugins/extractor.sh"), "hang", "$pdf", "$output"],
            accepted_inputs: [{ kind: "pdf", id: "pdf", label: "PDF", limits: [] }],
          },
        ],
      }),
    );
    const slow = await serveBucket({
      root: mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-slow-")),
      zoteroUrl: closedPortUrl(),
      extractionsManifest: manifest,
      config: { ...config, plugins: { ...config.plugins, extraction_timeout_seconds: 1 } },
    });
    try {
      const form = new FormData();
      form.set("pdf", new File([fixture("problem-set.pdf")], "problems.pdf"));
      form.set("pdf_url", published("/~author/problems.pdf"));
      form.set("title_hint", "Problem set on quadratic forms");
      const response = await slow.request("/capture-bytes", { method: "POST", body: form });
      expect(response.status).toBe(200);
      const { key } = CaptureResponseSchema.parse(await response.json());
      await page.goto(`${slow.origin}/`);
      await page.waitForSelector(row(key));
      await page.click(row(key));
      await page.click('button[aria-label="Run extraction"]');

      await shows(
        "aside [role='alert']",
        "Slow extractor ran past its 1 s limit and was stopped; nothing was written",
      );
      await shot("extraction-timed-out");
    } finally {
      await slow.stop();
    }
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
