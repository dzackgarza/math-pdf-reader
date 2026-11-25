
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import type {
  AnnotationPlugin,
  DocumentManagerPlugin,
  EmbedPdfContainer,
  ScrollPlugin,
  SelectionPlugin,
  ViewportPlugin,
  ZoomPlugin,
} from "@embedpdf/react-pdf-viewer";
import { $ } from "bun";
import puppeteer, {
  type BrowserContext,
  type Dialog,
  type HTTPRequest,
  type Page,
} from "puppeteer-core";
import { z } from "zod";
import { CaptureResponseSchema } from "../src/contract/capture";
import {
  CONFIG_PATH,
  loadAppConfig,
  STORE_COMMAND,
} from "../src/contract/config";
import {
  type BucketItem,
  LibraryPayloadSchema,
  ReadingRequestSchema,
} from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";
import { SCRATCH_DATA_HOME, SCREENSHOT_ROOT } from "./preload";
import { readOrganization, recordMetadata } from "./store";
import { refusal, zoteroStub } from "./zotero-stub";

setDefaultTimeout(30_000);

const fixtures = join(import.meta.dir, "fixtures");
const screenshots = join(SCREENSHOT_ROOT, "pdf-bucket-library-e2e");
const viewport = { width: 1400, height: 900 };

const fixture = (file: string) =>
  new Uint8Array(readFileSync(join(fixtures, file)));
const readingCopy = new Uint8Array([
  ...fixture("ten-page-notes.pdf"),
  ...new TextEncoder().encode("% the reading copy\n"),
]);

const CAPTURES = [
  ["lattices", fixture("lecture-notes.pdf"), "Lectures on integral lattices"],
  ["problems", fixture("problem-set.pdf"), "Problem set on quadratic forms"],
  ["notes", fixture("ten-page-notes.pdf"), "Ten lectures on lattice theory"],
  ["reading", readingCopy, "Ten lectures, the reading copy"],
  ["outlined", fixture("outlined-notes.pdf"), "Ten lectures with an outline"],
] as const;

function executable(name: string): string {
  const path = Bun.which(name);
  if (path === null) {
    throw new Error(
      `${name} is not on PATH; the library suite drives the real browser`,
    );
  }
  return path;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const served = new Map<string, Uint8Array<ArrayBuffer>>();
const publishCaptures = () => {
  served.clear();
  for (const [key, bytes] of CAPTURES) {
    served.set(`/~author/${key}.pdf`, bytes);
  }
};
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

async function serveLibrary(root: string, indexExport: string) {
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    indexExport,
  });
  return { root, origin: app.origin, indexExport, stop: app.stop };
}

async function captureLibrary() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-captured-"));
  const indexExport = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-export-")),
    "index.json",
  );
  const bucket = await serveLibrary(root, indexExport);
  for (const [key, bytes, linkText] of CAPTURES) {
    const form = new FormData();
    form.set("pdf", new File([bytes], `${key}.pdf`));
    form.set("pdf_url", published(`/~author/${key}.pdf`));
    form.set("title_hint", linkText);
    const response = await fetch(`${bucket.origin}/capture-bytes`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      throw new Error(
        `capture of ${key} failed: ${response.status} ${await response.text()}`,
      );
    }
  }
  await bucket.stop();
  rmSync(dirname(indexExport), { recursive: true, force: true });
  return root;
}

async function startBucket() {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-"));
  cpSync(capturedLibrary, root, { recursive: true });
  const indexExport = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-export-")),
    "index.json",
  );
  return serveLibrary(root, indexExport);
}

let bucket: Awaited<ReturnType<typeof startBucket>>;
let context: BrowserContext;
let page: Page;

const shot = async (name: string) => {
  mkdirSync(screenshots, { recursive: true });
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  await page.screenshot({ path: join(screenshots, `${name}.png`) });
};

test("arXiv replacement keeps the current PDF on failure and shows the new PDF on success", async () => {
  let downloadFails = true;
  const arxiv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/query") {
        return new Response(
          "<feed><entry><id>http://arxiv.org/abs/1234.5678v1</id><title>Promotion Notes</title><author><name>An Author</name></author></entry></feed>",
          { headers: { "Content-Type": "application/atom+xml" } },
        );
      }
      if (downloadFails) {
        return new Response("source unavailable", { status: 503 });
      }
      return new Response(fixture("problem-set.pdf"), {
        headers: { "Content-Type": "application/pdf" },
      });
    },
  });
  const endpoint = (path: string) => new URL(path, arxiv.url).href;
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-arxiv-ui-"));
  const config = loadAppConfig(CONFIG_PATH);
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    config: {
      ...config,
      arxiv: {
        api_url: endpoint("/api/query"),
        abs_url: endpoint("/abs/"),
        pdf_url: endpoint("/pdf/"),
        e_print_url: endpoint("/e-print/"),
        request_interval_seconds: 0,
      },
    },
  });
  try {
    const form = new FormData();
    form.set("pdf", new File([fixture("lecture-notes.pdf")], "original.pdf"));
    form.set("pdf_url", published("/~author/lattices.pdf"));
    form.set("title_hint", "Promotion Notes");
    const capture = await app.request("/capture-bytes", {
      method: "POST",
      body: form,
    });
    expect(capture.ok).toBe(true);
    await recordMetadata(root, "original", "resolver", {
      title: "Promotion Notes",
      authors: ["An Author"],
      year: 2024,
    });

    await page.goto(`${app.origin}/`);
    await page.waitForSelector(row("original"));
    await page.click(row("original"));
    const originalThumbnail = await page.$eval(
      'aside[aria-label="Item details"] img[alt="First page"]',
      (image) => (image as HTMLImageElement).src,
    );
    await (await byRole("button", "Find on arXiv")).click();
    await shows('aside[aria-label="Item details"]', "arXiv:1234.5678v1");
    const panel = await page.$eval(
      'aside[aria-label="Item details"]',
      (element) => element.textContent,
    );
    expect(panel).toContain("A failed download keeps the current PDF.");
    expect(panel).toContain("Replace with arXiv PDF");
    await (await byRole("button", "Replace with arXiv PDF")).click();
    await shows(
      'aside[aria-label="Item details"] [role="alert"]',
      "The current PDF remains available.",
    );
    expect(await rowKeys()).toEqual(["original"]);
    const failedSourceLinks = await page.$$eval(
      'aside[aria-label="Item details"] a',
      (anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
    );
    expect(failedSourceLinks).toContain(published("/~author/lattices.pdf"));
    await (
      await byRole("button", "Replace with arXiv PDF")
    ).evaluate((button) => button.scrollIntoView({ block: "center" }));
    await shot("arxiv-replacement-failed");

    await (await byRole("button", "Open")).click();
    await shownReader("original");
    await (await byRole("tab", "Library")).click();
    expect(await readerKeys()).toContain("original");
    downloadFails = false;
    await (await byRole("button", "Replace with arXiv PDF")).click();
    await shows("body", "Replaced the PDF with the arXiv version.");
    expect(await readerKeys()).toEqual([]);
    const library = LibraryPayloadSchema.parse(
      await (await app.request("/api/library")).json(),
    );
    expect(library.items).toHaveLength(1);
    expect(library.items[0]?.provenance.pdf_url).toBe(
      "https://arxiv.org/pdf/1234.5678v1",
    );
    expect(library.items[0]?.sourceLineage?.originalProvenance.pdf_url).toBe(
      published("/~author/lattices.pdf"),
    );
    await shows('aside[aria-label="Item details"]', "arxiv.org");
    const promotedPanel = await page.$eval(
      'aside[aria-label="Item details"]',
      (element) => element.textContent,
    );
    expect(promotedPanel).toContain("Original capture");
    const sourceLinks = await page.$$eval(
      'aside[aria-label="Item details"] a',
      (anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
    );
    expect(sourceLinks).toContain("https://arxiv.org/pdf/1234.5678v1");
    expect(sourceLinks).toContain(published("/~author/lattices.pdf"));
    const preferredThumbnail = await page.$eval(
      'aside[aria-label="Item details"] img[alt="First page"]',
      (image) => (image as HTMLImageElement).src,
    );
    expect(preferredThumbnail).not.toBe(originalThumbnail);
    await shot("arxiv-replacement");
  } finally {
    await app.stop();
    arxiv.stop(true);
  }
}, 120_000);
const organization = async () => readOrganization(bucket.root);
const api = async (method: string, path: string, body: unknown) => {
  const response = await fetch(`${bucket.origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response;
};
const detailValue = async (label: string) => {
  const terms = 'aside[aria-label="Item details"] dt';
  await page.waitForSelector(terms);
  return page.$$eval(
    terms,
    (found, wanted) =>
      found
        .find((term) => term.textContent?.trim() === wanted)
        ?.nextElementSibling?.textContent?.trim() ?? null,
    label,
  );
};
const libraryPayload = async () =>
  LibraryPayloadSchema.parse(
    await (await fetch(`${bucket.origin}/api/library`)).json(),
  );
const fileInto = async (name: string, keys: string[]) => {
  const created = z
    .object({ id: z.string() })
    .parse(await (await api("POST", "/api/collections", { name })).json());
  await api("POST", "/api/bulk/collections", {
    keys,
    add: [created.id],
    remove: [],
  });
  return created.id;
};
const markViewed = async (key: string, pageNumber: number, pages: number) => {
  const item = (await libraryPayload()).items.find(
    (candidate) => candidate.id === key,
  );
  if (item === undefined) {
    throw new Error(`the library holds no ${key}`);
  }
  await api("PUT", `/api/items/${key}/reading`, {
    page: pageNumber,
    pages,
    zoom: "automatic",
    edition: item.provenance,
  });
};
const storeCapturedAt = async (
  root: string,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  capturedAt: string,
) => {
  const source = join(mkdtempSync(join(tmpdir(), "pdf-bucket-old-")), "in.pdf");
  writeFileSync(source, bytes);
  mkdirSync(join(root, key));
  await $`${STORE_COMMAND} embed-provenance --pdf-url ${published(`/~author/${key}.pdf`)} --captured-at ${capturedAt} --original-sha256 ${sha256(bytes)} --title-hint ${key} -- ${source} ${join(root, key, `${key}.pdf`)}`.quiet();
  rmSync(dirname(source), { recursive: true, force: true });
};
const row = (key: string) => `tr[data-item-id="${key}"]`;
const rowKeys = () =>
  page.$$eval("tr[data-item-id]", (rows) =>
    rows.map((tr) => tr.getAttribute("data-item-id")),
  );
const shows = (selector: string, text: string) =>
  page.waitForFunction(
    (css, wanted) =>
      document.querySelector(css)?.textContent?.includes(wanted) === true,
    {},
    selector,
    text,
  );
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
const openRoot = async () => {
  await page.goto(`${bucket.origin}/`);
  await page.waitForSelector("nav a");
};
const tab = (key: string) => `[data-tab-key="${key}"]`;
const pressInDialog = async (label: string) => {
  await page.waitForSelector('[role="alertdialog"]', { visible: true });
  for (const button of await page.$$('[role="alertdialog"] button')) {
    if ((await button.evaluate((element) => element.textContent)) === label) {
      await button.click();
      return;
    }
  }
  throw new Error(`the dialog has no button labelled ${label}`);
};
const readerOf = (key: string) => `[data-reader-key="${key}"]`;
const viewerOf = (key: string) => `${readerOf(key)} embedpdf-container`;
const inViewer = (key: string, css: string) => `${viewerOf(key)} >>> ${css}`;
const readerButton = (key: string, command: string) =>
  inViewer(key, `[data-epdf-i="bucket:${command}"] button`);
const DISABLED = ".cursor-not-allowed";
const ACTIVE = ".bg-interactive-selected";
const PAGE_BOX = 'div[style*="transform-origin"][style*="background-color"]';
const openTabKeys = () =>
  page.$$eval("[data-tab-key]", (tabs) =>
    tabs.map((element) => element.getAttribute("data-tab-key")),
  );
const readerKeys = async () =>
  (
    await page.evaluate(async () => {
      const viewer =
        document.querySelector<EmbedPdfContainer>("embedpdf-container");
      const documents = (await viewer?.registry)
        ?.getPlugin<DocumentManagerPlugin>("document-manager")
        ?.provides();
      if (documents === undefined) {
        throw new Error("the window's viewer has no document manager");
      }
      return documents.getDocumentOrder();
    })
  ).sort();
const scrollOf = (key: string) =>
  page.evaluate(async (css) => {
    const viewer = document.querySelector<EmbedPdfContainer>(css);
    const viewport = (await viewer?.registry)
      ?.getPlugin<ViewportPlugin>("viewport")
      ?.provides();
    if (viewport === undefined) {
      throw new Error(`${css} has no viewport plugin`);
    }
    const metrics = viewport.getMetrics();
    return { top: metrics.scrollTop, left: metrics.scrollLeft };
  }, viewerOf(key));
const scrollSettled = async (key: string) => {
  for (;;) {
    const before = await scrollOf(key);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = await scrollOf(key);
    if (after.top === before.top && after.left === before.left) {
      return after;
    }
  }
};
const scrollBy = async (key: string, down: number) => {
  const from = await scrollSettled(key);
  await page.evaluate(
    async (css, to) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const viewport = (await viewer?.registry)
        ?.getPlugin<ViewportPlugin>("viewport")
        ?.provides();
      if (viewport === undefined) {
        throw new Error(`${css} has no viewport plugin`);
      }
      viewport.scrollTo({ ...to, behavior: "instant" });
    },
    viewerOf(key),
    { x: from.left, y: from.top + down },
  );
  await scrolledFrom(key, from.top);
  return scrollSettled(key);
};
const scrolledFrom = (key: string, top: number) =>
  page.waitForFunction(
    async (css, from) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const viewport = (await viewer?.registry)
        ?.getPlugin<ViewportPlugin>("viewport")
        ?.provides();
      return viewport !== undefined && viewport.getMetrics().scrollTop !== from;
    },
    {},
    viewerOf(key),
    top,
  );
const keysReach = async (key: string) => {
  const before = await zoomOf(key);
  await page.keyboard.down("Control");
  await page.keyboard.press("Equal");
  await page.keyboard.up("Control");
  await page.waitForFunction(
    async (css, unzoomed) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const zoom = (await viewer?.registry)
        ?.getPlugin<ZoomPlugin>("zoom")
        ?.provides();
      return zoom !== undefined && zoom.getState().zoomLevel !== unzoomed;
    },
    {},
    viewerOf(key),
    before,
  );
};
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
const readerLoaded = async (key: string) => {
  console.info("reader test load", { key, stage: "document" });
  await page.waitForFunction(
    async (css, wanted) => {
      const registry =
        await document.querySelector<EmbedPdfContainer>(css)?.registry;
      const documents = registry
        ?.getPlugin<DocumentManagerPlugin>("document-manager")
        ?.provides();
      const scroll = registry?.getPlugin<ScrollPlugin>("scroll")?.provides();
      if (documents === undefined || scroll === undefined) {
        return false;
      }
      return (
        documents.getActiveDocumentId() === wanted &&
        scroll.forDocument(wanted).getMetrics().pageVisibilityMetrics.length > 0
      );
    },
    {},
    viewerOf(key),
    key,
  );
  console.info("reader test load", { key, stage: "image" });
  await page.waitForFunction(
    (css, box) => {
      const root = document.querySelector(css)?.shadowRoot;
      return (
        root !== null &&
        root !== undefined &&
        [...root.querySelectorAll(`${box} img`)].some(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        )
      );
    },
    {},
    viewerOf(key),
    PAGE_BOX,
  );
  console.info("reader test load", { key, stage: "complete" });
};
const pageInput = (key: string) => inViewer(key, 'input[inputmode="numeric"]');
const showsPage = (key: string, pageNumber: number) =>
  page.waitForFunction(
    async (css, wanted) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const input = viewer?.shadowRoot?.querySelector(
        'input[inputmode="numeric"]',
      );
      const scroll = (await viewer?.registry)
        ?.getPlugin<ScrollPlugin>("scroll")
        ?.provides();
      return (
        input instanceof HTMLInputElement &&
        input.value === wanted &&
        scroll?.getMetrics().visiblePages.includes(Number(wanted)) === true
      );
    },
    {},
    viewerOf(key),
    String(pageNumber),
  );
const goToPage = async (key: string, pageNumber: number) => {
  console.info("reader test page entry", {
    key,
    pageNumber,
    stage: "focus",
  });
  await page.click(pageInput(key), { count: 3 });
  await page.keyboard.type(String(pageNumber));
  console.info("reader test page entry", {
    key,
    pageNumber,
    stage: "submit",
    value: await page.$eval(
      pageInput(key),
      (input) => (input as HTMLInputElement).value,
    ),
  });
  await page.keyboard.press("Enter");
  console.info("reader test page entry", {
    key,
    pageNumber,
    stage: "submitted",
    state: await page.evaluate(async (css) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const scroll = (await viewer?.registry)
        ?.getPlugin<ScrollPlugin>("scroll")
        ?.provides();
      const viewport = (await viewer?.registry)
        ?.getPlugin<ViewportPlugin>("viewport")
        ?.provides();
      if (scroll === undefined || viewport === undefined) {
        throw new Error(`${css} has no scroll or viewport plugin`);
      }
      return {
        page: scroll.getCurrentPage(),
        change: scroll.getPageChangeState(),
        visible: scroll.getMetrics().visiblePages,
        viewport: viewport.getMetrics(),
      };
    }, viewerOf(key)),
  });
  await showsPage(key, pageNumber);
  console.info("reader test page entry", {
    key,
    pageNumber,
    stage: "shown",
  });
  await scrollSettled(key);
  console.info("reader test page entry", {
    key,
    pageNumber,
    stage: "settled",
  });
};
const firstPageCorner = async (key: string) => {
  await page.evaluate(async (css) => {
    const viewer = document.querySelector<EmbedPdfContainer>(css);
    const scroll = (await viewer?.registry)
      ?.getPlugin<ScrollPlugin>("scroll")
      ?.provides();
    if (scroll === undefined) {
      throw new Error(`${css} has no scroll plugin`);
    }
    scroll.scrollToPage({ pageNumber: 1, behavior: "instant" });
  }, viewerOf(key));
  const corner = async () =>
    z.object({ x: z.number(), y: z.number(), width: z.number() }).parse(
      await (
        await page.waitForFunction(
          (css, box) => {
            const root = document.querySelector(css)?.shadowRoot;
            if (root === null || root === undefined) {
              return false;
            }
            const tops = [...root.querySelectorAll(box)]
              .map((element) => element.getBoundingClientRect())
              .sort((one, other) => one.y - other.y);
            const first = tops[0];
            return (
              first !== undefined &&
              first.y >= 0 && { x: first.x, y: first.y, width: first.width }
            );
          },
          {},
          viewerOf(key),
          PAGE_BOX,
        )
      ).jsonValue(),
    );
  for (let before = await corner(); ; ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = await corner();
    if (
      after.x === before.x &&
      after.y === before.y &&
      after.width === before.width
    ) {
      return after;
    }
    before = after;
  }
};
const writeNote = async (key: string, note: string, down = 160) => {
  await page.click(inViewer(key, '[data-epdf-i="annotate-mode"] button'));
  const inHand = await page.evaluate(async (css) => {
    const viewer = document.querySelector<EmbedPdfContainer>(css);
    const annotations = (await viewer?.registry)
      ?.getPlugin<AnnotationPlugin>("annotation")
      ?.provides();
    if (annotations === undefined) {
      throw new Error(`${css} has no annotation plugin`);
    }
    const tool = annotations.getActiveTool();
    return tool === null ? null : tool.id;
  }, viewerOf(key));
  if (inHand !== "freeText") {
    await page.click(inViewer(key, '[data-epdf-i="add-text"] button'));
  }
  const corner = await firstPageCorner(key);
  console.info("reader test note", {
    key,
    stage: "corner",
    corner,
    existingEditor:
      (await page.$(inViewer(key, '[contenteditable="true"]'))) !== null,
  });
  if ((await page.$(inViewer(key, '[contenteditable="true"]'))) !== null) {
    await page.mouse.click(corner.x + 120, corner.y + down);
    await page.waitForSelector(inViewer(key, '[contenteditable="true"]'), {
      hidden: true,
    });
    console.info("reader test note", { key, stage: "old-editor-closed" });
  }
  await page.mouse.click(corner.x + 120, corner.y + down);
  await page.waitForSelector(inViewer(key, '[contenteditable="true"]'));
  console.info("reader test note", { key, stage: "editor-open" });
  await page.keyboard.type(note);
  console.info("reader test note", { key, stage: "text-entered" });
  await page.keyboard.press("Escape");
  console.info("reader test note", { key, stage: "complete" });
};
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
      return (
        await annotations.getPageAnnotations({ pageIndex: 0 }).toPromise()
      ).flatMap((annotation) =>
        annotation.contents === undefined ? [] : [annotation.contents],
      );
    }, viewerOf(key)),
  );
};
const zoomOf = async (key: string) =>
  z.union([z.number(), z.enum(["automatic", "fit-page", "fit-width"])]).parse(
    await page.evaluate(async (css) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const zoom = (await viewer?.registry)
        ?.getPlugin<ZoomPlugin>("zoom")
        ?.provides();
      if (zoom === undefined) {
        throw new Error(`${css} has no zoom plugin`);
      }
      return zoom.getState().zoomLevel;
    }, viewerOf(key)),
  );
const zoomTo = async (key: string, level: number) => {
  await page.evaluate(
    async (css, wanted) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const zoom = (await viewer?.registry)
        ?.getPlugin<ZoomPlugin>("zoom")
        ?.provides();
      if (zoom === undefined) {
        throw new Error(`${css} has no zoom plugin`);
      }
      zoom.requestZoom(wanted);
    },
    viewerOf(key),
    level,
  );
  await page.waitForFunction(
    async (css, wanted) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const zoom = (await viewer?.registry)
        ?.getPlugin<ZoomPlugin>("zoom")
        ?.provides();
      return zoom?.getState().currentZoomLevel === wanted;
    },
    {},
    viewerOf(key),
    level,
  );
  await scrollSettled(key);
};
const shownReader = async (key: string) => {
  await page.waitForSelector(`${tab(key)}[data-state="active"]`);
  await page.waitForSelector(readerOf(key), { visible: true });
  await readerLoaded(key);
};

await $`just build-web`.env({ ...process.env, NODE_ENV: "production" }).quiet();
const capturedLibrary = await captureLibrary();
const browser = await puppeteer.launch({
  browser: "chrome",
  executablePath: executable("chromium"),
  headless: true,
  defaultViewport: viewport,
});

beforeEach(async () => {
  publishCaptures();
  bucket = await startBucket();
  context = await browser.createBrowserContext();
  await context.overridePermissions(bucket.origin, [
    "clipboard-read",
    "clipboard-sanitized-write",
  ]);
  page = await context.newPage();
  page.on("console", (message) =>
    console.info("browser console", message.type(), message.text()),
  );
});

afterEach(async () => {
  await context.close();
  await bucket.stop();
  rmSync(bucket.root, { recursive: true, force: true });
  rmSync(dirname(bucket.indexExport), { recursive: true, force: true });
});

afterAll(async () => {
  await browser.close();
  rmSync(capturedLibrary, { recursive: true, force: true });
  publisher.stop(true);
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
  expect(org.items.lattices?.collections).toEqual(
    created.map((collection) => collection.id),
  );
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
      const image = document.querySelector<HTMLImageElement>(
        'aside img[alt="First page"]',
      );
      return image?.complete === true && image.naturalWidth > 0;
    });
    await shot("details-metadata-edit");
    await page.setViewport({ width: 700, height: 900 });
    await shot("details-metadata-edit-narrow");
    await page.setViewport(viewport);

    await page.click('input[aria-label="Title"]', { count: 3 });
    await page.keyboard.press("Backspace");
    await page.type(
      'input[aria-label="Title"]',
      "Corrected title from the paper",
    );
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
    expect(
      await page.$eval("aside header", (header) => header.textContent),
    ).toContain("Ada Researcher, Benoit Scholar · 2024");
    const payload = LibraryPayloadSchema.parse(
      await (await fetch(`${bucket.origin}/api/library`)).json(),
    );
    expect(
      payload.items.find((item) => item.id === captured.key),
    ).toMatchObject({
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
  const quadratic = org.collections.filter(
    (collection) => collection.name === "Quadratic forms",
  );
  expect(quadratic).toHaveLength(1);
  expect(org.items.problems?.collections).toEqual(
    quadratic.map((collection) => collection.id),
  );
  expect(org.items.problems?.tags).toEqual(["exercises"]);
});

test("a PDF tab's context menu holds its item's menu: Add Tag… there tags the item", async () => {
  await openLibrary();
  await page.click(row("notes"), { count: 2 });
  await shownReader("notes");
  await page.click(tab("notes"), { button: "right" });
  await (await menuItem("Send to Zotero")).hover();
  await shot("tab-context-menu");
  await (await menuItem("Add Tag…")).click();
  await page.type('[role="dialog"] input', "from-tab");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"]') === null,
  );
  expect((await organization()).items.notes?.tags).toContain("from-tab");
  await page.click(tab("notes"), { button: "right" });
  await (await menuItem("Close Tab")).click();
  await page.waitForSelector(tab("notes"), { hidden: true });
});

test("Delete in the row context menu moves the PDF to the trash and drops the item", async () => {
  await openLibrary();
  const pdf = join(bucket.root, "notes", "notes.pdf");
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
  const trashed = readdirSync(trash, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("notes"))
    .map((entry) => sha256(readFileSync(join(trash, entry.name, "notes.pdf"))));
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

  const deleted = await fetch(`${bucket.origin}/api/items/${key}`, {
    method: "DELETE",
  });
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
  const focused = await page.evaluate(() =>
    document.activeElement?.getAttribute("aria-label"),
  );
  expect(focused).toBe("Search");
  await page.keyboard.type("quadratic");
  await page.waitForFunction(
    () => document.querySelectorAll("tr[data-item-id]").length === 1,
  );
  expect(await rowKeys()).toEqual(["problems"]);
  await page.click('input[aria-label="Search"]', { count: 3 });
  await page.keyboard.press("Backspace");
  await page.waitForFunction(
    () => document.querySelectorAll("tr[data-item-id]").length > 1,
  );

  await page.keyboard.down("Control");
  await page.keyboard.press("p");
  await page.keyboard.up("Control");
  await page.keyboard.type("intlat");
  await shot("palette-items");
  await page.keyboard.press("Enter");
  await page.waitForSelector(
    "aside h2 ::-p-text(Lectures on integral lattices)",
  );

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
  expect(
    await page.$eval(unfiled, (button) => button.getAttribute("aria-pressed")),
  ).toBe("true");
  expect(await openTabKeys()).toEqual(tabsBefore);

  await page.keyboard.press("Enter");
  await page.waitForSelector(`${unfiled}[aria-pressed="false"]`);
});

test("wheel reading keeps its position as pages render", async () => {
  await page.goto(`${bucket.origin}/read/reading#page=1`);
  await readerLoaded("reading");
  await scrollSettled("reading");
  const idleMoves = await page.evaluate(async () => {
    const viewer =
      document.querySelector<EmbedPdfContainer>("embedpdf-container");
    const registry = await viewer?.registry;
    const viewport = registry?.getPlugin<ViewportPlugin>("viewport");
    const documents = registry
      ?.getPlugin<DocumentManagerPlugin>("document-manager")
      ?.provides();
    const key = documents?.getActiveDocumentId();
    if (
      viewport === null ||
      viewport === undefined ||
      key === null ||
      key === undefined
    ) {
      throw new Error("the reader has no active viewport");
    }
    viewport
      .provides()
      .forDocument(key)
      .scrollTo({ x: 0, y: 400, behavior: "instant" });
    const destinations: { x: number; y: number }[] = [];
    const stop = viewport.onScrollRequest(key, ({ x, y }) =>
      destinations.push({ x, y }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    stop();
    return destinations;
  });
  expect(idleMoves).toEqual([]);
  await page.mouse.move(900, 600);
  for (const delta of [
    ...Array<number>(24).fill(240),
    ...Array<number>(24).fill(-240),
  ]) {
    const before = await scrollOf("reading");
    await page.mouse.wheel({ deltaY: delta });
    await scrolledFrom("reading", before.top);
    const after = await scrollSettled("reading");
    expect(Math.abs(after.top - before.top - delta)).toBeLessThanOrEqual(1);
  }
});

test("reader back and forward walk the positions visited in the PDF and stay in it; on its own, the reader's Library returns to the view the library last showed", async () => {
  await page.goto(`${bucket.origin}/#/unfiled`);
  await page.waitForSelector(row("reading"));
  await page.goto(`${bucket.origin}/read/reading#page=1`);
  await readerLoaded("reading");
  const unscrolled = (await scrollOf("reading")).top;
  await page.keyboard.press("PageDown");
  await scrolledFrom("reading", unscrolled);
  expect((await scrollOf("reading")).top).toBeGreaterThan(unscrolled + 100);
  await page.keyboard.press("Home");
  await page.waitForFunction(
    async (css) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const viewport = (await viewer?.registry)
        ?.getPlugin<ViewportPlugin>("viewport")
        ?.provides();
      return viewport?.getMetrics().scrollTop === 0;
    },
    {},
    viewerOf("reading"),
  );
  await goToPage("reading", 7);
  await page.waitForFunction(() => location.hash === "#page=7");
  const within7 = await scrollBy("reading", 120);
  await goToPage("reading", 3);
  await page.waitForFunction(() => location.hash === "#page=3");
  await shot("reader");

  const back = readerButton("reading", "back");
  const forward = readerButton("reading", "forward");
  await page.click(back);
  await showsPage("reading", 7);
  expect((await scrollOf("reading")).top).toBeCloseTo(within7.top, 0);
  await page.click(back);
  await showsPage("reading", 1);
  await page.waitForSelector(`${back}${DISABLED}`);
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

  await page.click(readerButton("reading", "library"));
  await page.waitForSelector(row("reading"));
  expect(new URL(page.url()).hash).toBe("#/unfiled");

  await page.goto(address);
  await readerLoaded("reading");
  await showsPage("reading", 7);
  await page.setViewport({ width: 700, height: 900 });
  await shot("reader-narrow");
  await page.setViewport(viewport);
});

test("back returns to the place inside the page an outline entry or a search match left, and rapid back and forward end where they were sent", async () => {
  await page.goto(`${bucket.origin}/read/outlined`);
  await readerLoaded("outlined");
  const back = readerButton("outlined", "back");
  const forward = readerButton("outlined", "forward");

  await page.click(
    inViewer("outlined", '[data-epdf-i="sidebar-button"] button'),
  );
  await page.waitForSelector(inViewer("outlined", '[role="tab"]'));
  const [, outlineTab] = await page.$$(inViewer("outlined", '[role="tab"]'));
  await outlineTab?.click();
  const scaleOf = () =>
    page.evaluate(async (css) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      return (await viewer?.registry)
        ?.getPlugin<ZoomPlugin>("zoom")
        ?.provides()
        .getState().currentZoomLevel;
    }, viewerOf("outlined"));
  for (let before = await scaleOf(); ; ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await scaleOf();
    if (after === before) {
      break;
    }
    before = after;
  }
  await goToPage("outlined", 2);
  const within2 = await scrollBy("outlined", 120);
  const entry = await page.waitForFunction(
    (css) => {
      const root = document.querySelector(css)?.shadowRoot;
      if (root === null || root === undefined) {
        return false;
      }
      const span = [...root.querySelectorAll("span")].find(
        (element) => element.textContent === "Dual lattices",
      );
      const box = span?.getBoundingClientRect();
      return (
        box !== undefined && {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        }
      );
    },
    {},
    viewerOf("outlined"),
  );
  const center = z
    .object({ x: z.number(), y: z.number() })
    .parse(await entry.jsonValue());
  await page.mouse.click(center.x, center.y);
  await showsPage("outlined", 3);
  await scrollSettled("outlined");
  await page.click(back);
  await showsPage("outlined", 2);
  await scrollSettled("outlined");
  expect((await scrollOf("outlined")).top).toBeCloseTo(within2.top, 0);

  await page.keyboard.down("Control");
  await page.keyboard.press("f");
  await page.keyboard.up("Control");
  await page.keyboard.type("unimodular");
  await showsPage("outlined", 6);
  await scrollSettled("outlined");
  await page.click(back);
  await showsPage("outlined", 2);
  await scrollSettled("outlined");
  expect((await scrollOf("outlined")).top).toBeCloseTo(within2.top, 0);

  await page.click(forward);
  await showsPage("outlined", 6);
  await scrollSettled("outlined");
  await page.click(back);
  await page.click(forward);
  await page.click(back);
  await showsPage("outlined", 2);
  await scrollSettled("outlined");
  expect((await scrollOf("outlined")).top).toBeCloseTo(within2.top, 0);
});

test("a link in the PDF to another page is a jump that back returns from, to the place it left", async () => {
  const form = new FormData();
  form.set("pdf", new File([fixture("linked-notes.pdf")], "linked-notes.pdf"));
  form.set("pdf_url", published("/~author/linked-notes.pdf"));
  form.set("title_hint", "Notes with a link");
  const captured = await fetch(`${bucket.origin}/capture-bytes`, {
    method: "POST",
    body: form,
  });
  expect(captured.status).toBe(200);
  const key = CaptureResponseSchema.parse(await captured.json()).key;

  await page.goto(`${bucket.origin}/read/${key}`);
  await readerLoaded(key);
  const corner = await firstPageCorner(key);
  const top = (await scrollOf(key)).top;
  const left = await scrollBy(key, 40);
  const scale = corner.width / 612;
  await page.mouse.click(
    corner.x + 249 * scale,
    corner.y - (left.top - top) + 165 * scale,
  );
  await showsPage(key, 3);
  await scrollSettled(key);
  await page.click(readerButton(key, "back"));
  await showsPage(key, 1);
  await scrollSettled(key);
  expect((await scrollOf(key)).top).toBeCloseTo(left.top, 0);

  const deleted = await fetch(`${bucket.origin}/api/items/${key}`, {
    method: "DELETE",
  });
  expect(deleted.ok).toBe(true);
});

test("the reader draws a font the PDF does not embed with a fallback font the bucket serves", async () => {
  const form = new FormData();
  form.set("pdf", new File([fixture("japanese-text.pdf")], "japanese.pdf"));
  form.set("pdf_url", published("/~author/japanese.pdf"));
  form.set("title_hint", "Lattice notes in Japanese");
  const response = await fetch(`${bucket.origin}/capture-bytes`, {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(200);
  const { key } = CaptureResponseSchema.parse(await response.json());
  const requested: string[] = [];
  const record = (request: HTTPRequest) => requested.push(request.url());
  page.on("request", record);
  try {
    const font = page.waitForRequest((request) =>
      /\.(ttf|otf)$/.test(request.url()),
    );
    await page.goto(`${bucket.origin}/read/${key}`);
    await readerLoaded(key);
    await font;
    const fonts = requested.filter((url) => /\.(ttf|otf)$/.test(url));
    expect(fonts.length).toBeGreaterThan(0);
    for (const url of fonts) {
      expect(url).toStartWith(`${bucket.origin}/fonts/jp/`);
      expect((await fetch(url)).status).toBe(200);
    }
  } finally {
    page.off("request", record);
    await fetch(`${bucket.origin}/api/items/${key}`, { method: "DELETE" });
  }
});

test("the reader link button copies the captured PDF URL", async () => {
  await page.goto(`${bucket.origin}/read/lattices`);
  await readerLoaded("lattices");
  await page.evaluate(() => navigator.clipboard.writeText("probe"));

  await page.click(readerButton("lattices", "copy-link"));
  await page.waitForSelector(
    `${readerOf("lattices")} [role="status"]::-p-text(PDF link copied)`,
  );

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
  await page.waitForSelector(`${tab("problems")}[data-state="active"]`);
  await (await byRole("tab", "Library")).click();
  await page.waitForSelector(`${row("problems")}[aria-selected="true"]`, {
    visible: true,
  });
  expect(new URL(page.url()).pathname).toBe("/");
  await readerLoaded("problems");
  await page.click(row("problems"));
  await page.keyboard.press("Enter");
  await shownReader("problems");
  await keysReach("problems");
  expect(await openTabKeys()).toEqual(["problems"]);
  expect(
    await page.$eval(tab("problems"), (element) => element.textContent),
  ).toBe(titleOf("problems"));
  expect(await page.$(readerButton("problems", "library"))).toBeNull();
  await shot("tabs-reader");

  await (await byRole("tab", "Library")).click();
  await page.click(row("reading"));
  await page.keyboard.press("Enter");
  await shownReader("reading");
  expect(await openTabKeys()).toEqual(["problems", "reading"]);
  await shot("tabs-two");

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

test("two open PDFs keep their own page and zoom through switches between them and the Library, and each switch shows its PDF within 2 s", async () => {
  const at = {
    notes: { page: 3, zoom: 1.5 },
    reading: { page: 5, zoom: 0.8 },
  } as const;
  const keys = ["notes", "reading"] as const;
  await openLibrary();
  for (const key of keys) {
    await (await byRole("tab", "Library")).click();
    await page.click(row(key), { count: 2 });
    await shownReader(key);
    await zoomTo(key, at[key].zoom);
    await goToPage(key, at[key].page);
  }
  const switches: { to: string; milliseconds: number }[] = [];
  const switchTo = async (key: (typeof keys)[number]) => {
    const started = performance.now();
    await page.click(`${tab(key)} [role="tab"]`);
    await shownReader(key);
    await showsPage(key, at[key].page);
    switches.push({ to: key, milliseconds: performance.now() - started });
    expect(await zoomOf(key)).toBe(at[key].zoom);
  };
  await switchTo("notes");
  await switchTo("reading");
  await (await byRole("tab", "Library")).click();
  await page.waitForSelector(row("notes"), { visible: true });
  await switchTo("notes");
  await switchTo("reading");
  await shot("tabs-switched");
  console.info("reader switch timing", switches);
  for (const { milliseconds } of switches) {
    expect(milliseconds).toBeLessThan(2000);
  }
}, 60_000);

test("a PDF shown from its library row or from its tab is the one tab selected, the one PDF the viewer shows, at its own page, and the library rows show the pages left", async () => {
  const agree = async (key: string, pageNumber: number) => {
    expect(
      await page.$$eval('[data-tab-key][data-state="active"]', (tabs) =>
        tabs.map((element) => element.getAttribute("data-tab-key")),
      ),
    ).toEqual([key]);
    await shownReader(key);
    await showsPage(key, pageNumber);
  };
  const readingCell = (key: string, text: string) =>
    page.waitForFunction(
      (css, wanted) =>
        document.querySelector(`${css} [data-reading]`)?.textContent === wanted,
      {},
      row(key),
      text,
    );
  await openLibrary();
  await page.click(row("notes"), { count: 2 });
  await agree("notes", 1);
  await goToPage("notes", 4);

  await (await byRole("tab", "Library")).click();
  await page.click(row("reading"));
  await page.keyboard.press("Enter");
  await agree("reading", 1);
  await goToPage("reading", 6);

  await page.click(`${tab("notes")} [role="tab"]`);
  await agree("notes", 4);
  await page.click(`${tab("reading")} [role="tab"]`);
  await agree("reading", 6);

  await (await byRole("tab", "Library")).click();
  await readingCell("notes", "4 / 10");
  await readingCell("reading", "6 / 10");
  await page.click(row("notes"), { count: 2 });
  await agree("notes", 4);
}, 60_000);

test("while a PDF's tab shows, the window's address is that PDF's reader at the page shown; the Library tab gives back the library's own address and view", async () => {
  const addressBecomes = async (wanted: string) => {
    await page
      .waitForFunction(
        (text) => window.location.pathname + window.location.hash === text,
        { timeout: 5000 },
        wanted,
      )
      .catch(() => undefined);
    const url = new URL(page.url());
    expect(url.pathname + url.hash).toBe(wanted);
  };
  await page.goto(`${bucket.origin}/#/unfiled`);
  await page.waitForSelector(row("notes"));
  await page.click(row("notes"), { count: 2 });
  await shownReader("notes");
  await addressBecomes("/read/notes#page=1");
  await goToPage("notes", 4);
  await addressBecomes("/read/notes#page=4");

  await (await byRole("tab", "Library")).click();
  await addressBecomes("/#/unfiled");
  await page.click(row("reading"));
  await page.keyboard.press("Enter");
  await shownReader("reading");
  await addressBecomes("/read/reading#page=1");
  await page.click(`${tab("notes")} [role="tab"]`);
  await shownReader("notes");
  await addressBecomes("/read/notes#page=4");
  await shot("tabs-address");

  await (await byRole("tab", "Library")).click();
  await addressBecomes("/#/unfiled");
  await page.waitForSelector(`${row("reading")}[aria-selected="true"]`, {
    visible: true,
  });
  expect(
    await page.$eval('button[aria-label="Unfiled"]', (button) =>
      button.getAttribute("aria-pressed"),
    ),
  ).toBe("true");
  await page.click('button[aria-label="Unread"]');
  await addressBecomes("/#/unread");
  await page.waitForSelector('button[aria-label="Unread"][aria-pressed="true"]');
}, 60_000);

test("a reload of the library window gives back its tabs in order, the tab shown at its page and zoom, and the Library when it showed", async () => {
  const address = () => {
    const url = new URL(page.url());
    return url.pathname + url.hash;
  };
  const tabKeys = () =>
    page.$$eval("[data-tab-key]", (tabs) =>
      tabs.map((tab) => tab.getAttribute("data-tab-key")),
    );
  await page.goto(`${bucket.origin}/#/unfiled`);
  await page.waitForSelector(row("notes"));
  expect(await tabKeys()).toEqual([]);
  await page.click(row("notes"), { count: 2 });
  await shownReader("notes");
  await goToPage("notes", 3);
  await zoomTo("notes", 1.5);
  await (await byRole("tab", "Library")).click();
  await page.click(row("reading"));
  await page.keyboard.press("Enter");
  await shownReader("reading");
  await goToPage("reading", 5);
  await page.waitForFunction(
    () => window.location.pathname + window.location.hash === "/read/reading#page=5",
  );

  await page.reload();
  await page.waitForSelector(tab("reading"), { timeout: 10_000 }).catch(() => undefined);
  expect({ tabs: await tabKeys(), address: address() }).toEqual({
    tabs: ["notes", "reading"],
    address: "/read/reading#page=5",
  });
  await shownReader("reading");
  await showsPage("reading", 5);
  await page.click(`${tab("notes")} [role="tab"]`);
  await shownReader("notes");
  await showsPage("notes", 3);
  expect(await zoomOf("notes")).toBe(1.5);

  await (await byRole("tab", "Library")).click();
  await page.waitForFunction(() => window.location.hash === "#/unfiled");
  await page.reload();
  await page.waitForSelector(row("notes"), { visible: true });
  await page.waitForSelector(tab("reading"), { timeout: 10_000 }).catch(() => undefined);
  expect({ tabs: await tabKeys(), address: address() }).toEqual({
    tabs: ["notes", "reading"],
    address: "/#/unfiled",
  });
  await shot("tabs-reloaded");
}, 90_000);

test("past five PDF tabs the one shown longest ago sleeps, its PDF closed in the viewer, and wakes at the same place and zoom when shown; Sleep Tab in a tab's menu puts that tab to sleep, showing the tab to its right in place of the one shown", async () => {
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
  const asleep = async (key: string) => {
    await page.waitForSelector(`${tab(key)}[data-asleep="true"]`);
    await page.waitForFunction(
      async (closed) => {
        const viewer =
          document.querySelector<EmbedPdfContainer>("embedpdf-container");
        const documents = (await viewer?.registry)
          ?.getPlugin<DocumentManagerPlugin>("document-manager")
          ?.provides();
        return documents?.getDocumentOrder().includes(closed) === false;
      },
      {},
      key,
    );
  };

  await openLibrary();
  await page.click(row(first), { count: 2 });
  await shownReader(first);
  await goToPage(first, 3);
  const unzoomed = await zoomOf(first);
  await page.click(inViewer(first, 'button[aria-label="Zoom In"]'));
  await page.waitForFunction(
    async (css, before) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const zoom = (await viewer?.registry)
        ?.getPlugin<ZoomPlugin>("zoom")
        ?.provides();
      return zoom !== undefined && zoom.getState().zoomLevel !== before;
    },
    {},
    viewerOf(first),
    unzoomed,
  );
  const zoomed = await zoomOf(first);
  const within3 = await scrollBy(first, 120);
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
  expect(await zoomOf(first)).toBe(zoomed);
  const woken = await scrollOf(first);
  expect(woken.top).toBeCloseTo(within3.top, 0);
  expect(woken.left).toBeCloseTo(within3.left, 0);
  await keysReach(first);
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
  expect(await readerKeys()).toEqual(
    later.filter((key) => key !== third).sort(),
  );

  for (const key of [first, ...later]) {
    const deleted = await fetch(`${bucket.origin}/api/items/${key}`, {
      method: "DELETE",
    });
    expect(deleted.ok).toBe(true);
  }
}, 60_000);

test("closing a PDF's tab right after a note is written saves the note into the PDF first", async () => {
  console.info("reader note-close test", { stage: "open-library" });
  await openLibrary();
  await page.click(row("outlined"), { count: 2 });
  console.info("reader note-close test", { stage: "wait-reader" });
  await shownReader("outlined");
  const note = `Closed at once ${Date.now()}`;
  console.info("reader note-close test", { stage: "write-note" });
  await writeNote("outlined", note);
  console.info("reader note-close test", { stage: "close-tab" });
  await page.click(`${tab("outlined")} button[aria-label^="Close"]`);
  console.info("reader note-close test", { stage: "wait-library" });
  await page
    .waitForSelector(row("outlined"), { visible: true, timeout: 15_000 })
    .catch(async () => {
      const shown = await page.evaluate(() => ({
        tabs: [...document.querySelectorAll("[data-tab-key]")].map(
          (element) => element.outerHTML,
        ),
        dialogs: [
          ...document.querySelectorAll('[role="alertdialog"], [role="alert"]'),
        ].map((element) => element.textContent),
      }));
      throw new Error(
        `closing the tab did not show the library: ${JSON.stringify(shown)}`,
      );
    });
  expect(await openTabKeys()).toEqual([]);
  console.info("reader note-close test", { stage: "tab-closed" });

  await page.goto(`${bucket.origin}/read/outlined`);
  console.info("reader note-close test", { stage: "standalone-opened" });
  await readerLoaded("outlined");
  console.info(
    "reader note-close reopened state",
    await page.evaluate(async (css) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const registry = await viewer?.registry;
      const documents = registry
        ?.getPlugin<DocumentManagerPlugin>("document-manager")
        ?.provides();
      const scroll = registry?.getPlugin<ScrollPlugin>("scroll")?.provides();
      const active = documents?.getActiveDocumentId();
      return {
        active,
        order: documents?.getDocumentOrder(),
        visibility:
          active === undefined || active === null
            ? null
            : scroll?.forDocument(active).getMetrics().pageVisibilityMetrics,
        images: viewer?.shadowRoot?.querySelectorAll(
          'div[style*="transform-origin"][style*="background-color"] img',
        ).length,
      };
    }, viewerOf("outlined")),
  );
  expect(await notesOnFirstPage("outlined")).toContain(note);
  console.info("reader note-close test", { stage: "note-found" });
});

test("a note saved over a PDF changed elsewhere shows the conflict, and closing its tab asks first until the copy is saved over it", async () => {
  await openLibrary();
  await page.click(row("reading"), { count: 2 });
  await shownReader("reading");
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
      response.url().endsWith("/api/items/reading/pdf") &&
      response.request().method() === "PUT",
  );
  const note = `Written over a stale PDF ${Date.now()}`;
  await writeNote("reading", note);
  expect((await refused).status()).toBe(412);
  const conflict = `${readerOf("reading")} [role="alert"]`;
  await page.waitForSelector(conflict, { visible: true });
  await shot("reader-save-conflict");

  await page.click(`${tab("reading")} button[aria-label^="Close"]`);
  const ask = await page.waitForSelector('[role="alertdialog"]', {
    visible: true,
  });
  expect(await ask?.evaluate((element) => element.textContent)).toContain(
    "changed elsewhere",
  );
  await pressInDialog("Cancel");
  await page.waitForSelector('[role="alertdialog"]', { hidden: true });
  await page.waitForSelector(`${tab("reading")}[data-state="active"]`);
  expect(await openTabKeys()).toContain("reading");
  expect(await quitOutcome()).toBe("failed");

  const kept = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/items/reading/pdf") &&
      response.request().method() === "PUT",
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

test("a failed annotation save still warns before leaving the reader page", async () => {
  await page.goto(`${bucket.origin}/read/lattices`);
  await readerLoaded("lattices");
  const path = join(bucket.root, "lattices", "lattices.pdf");
  const original = sha256(readFileSync(path));
  const mode = statSync(bucket.root).mode;
  await page.tracing.start({
    path: join(screenshots, "reader-failed-save.trace.json"),
    screenshots: true,
  });
  chmodSync(bucket.root, 0o500);
  try {
    const failed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/lattices/pdf") &&
        response.request().method() === "PUT",
    );
    await writeNote("lattices", "This note must survive a failed save", 480);
    expect((await failed).status()).toBe(500);
    await shows(readerOf("lattices"), "Not saved:");
    expect(sha256(readFileSync(path))).toBe(original);
    await shot("reader-failed-save");

    const outcome = new Promise<string>((resolve) => {
      page.once("dialog", (dialog) => {
        void dialog.dismiss().then(() => resolve(dialog.type()));
      });
      page.once("load", () => resolve("navigated"));
    });
    await page.evaluate(() => {
      location.href = "/";
    });
    const decision = await outcome;
    await shot("reader-failed-save-after-leaving");
    expect(decision).toBe("beforeunload");
    expect(new URL(page.url()).pathname).toBe("/read/lattices");
  } finally {
    chmodSync(bucket.root, mode);
    await page.tracing.stop();
    await page.close();
    page = await context.newPage();
  }
});

test("saving my copy can recover after another save changes an already conflicting PDF", async () => {
  await page.goto(`${bucket.origin}/read/reading`);
  await readerLoaded("reading");
  await page.tracing.start({
    path: join(screenshots, "reader-repeated-conflict.trace.json"),
    screenshots: true,
  });
  const saveElsewhere = async (comment: string) => {
    const stored = await fetch(`${bucket.origin}/pdf/reading.pdf`);
    const tag = stored.headers.get("ETag");
    if (tag === null) {
      throw new Error("the stored PDF carries no entity tag");
    }
    const response = await fetch(`${bucket.origin}/api/items/reading/pdf`, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "If-Match": tag },
      body: new Uint8Array([
        ...new Uint8Array(await stored.arrayBuffer()),
        ...new TextEncoder().encode(`\n% ${comment}\n`),
      ]),
    });
    expect(response.status).toBe(200);
  };
  const nextSave = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/reading/pdf") &&
        response.request().method() === "PUT",
    );
  try {
    await saveElsewhere("first external save");
    const refused = nextSave();
    const note = `Keep this note through repeated conflicts ${Date.now()}`;
    await writeNote("reading", note, 360);
    expect((await refused).status()).toBe(412);
    const button = `${readerOf("reading")} [role="alert"] button::-p-text(Save my copy over it)`;
    await page.waitForSelector(button, { visible: true });
    await saveElsewhere("second external save while the conflict is shown");

    const changedAgain = nextSave();
    await page.click(button);
    expect((await changedAgain).status()).toBe(412);
    await shows(readerOf("reading"), "Not saved:");
    await shot("reader-repeated-conflict");
    const kept = nextSave();
    await page.click(button);
    expect((await kept).status()).toBe(200);
    await page.waitForSelector(button, { hidden: true });
    await page.reload();
    expect(await notesOnFirstPage("reading")).toContain(note);
    await shot("reader-repeated-conflict-saved");
  } finally {
    await page.tracing.stop();
    await page.close();
    page = await context.newPage();
  }
});

test("a capture made while the library is open opens its PDF in a tab", async () => {
  await openLibrary();
  const form = new FormData();
  form.set(
    "pdf",
    new File([readFileSync(join(fixtures, "problem-set.pdf"))], "problems.pdf"),
  );
  form.set("pdf_url", published("/~author/problems.pdf"));
  form.set("title_hint", "Problem set on quadratic forms");
  const response = await fetch(`${bucket.origin}/capture-bytes`, {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(200);
  await shownReader("problems");
  await readerLoaded("problems");
  await keysReach("problems");
});

test("the status bar shows Zotero's state; a capture's reader opened before Retrieve metadata answers takes the title it resolves, in its tab and on its own page, and a source nothing identifies shows why", async () => {
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
        return new Response(
          readFileSync(join(fixtures, "zotero/version.json")),
          { headers },
        );
      }
      const { url } = z
        .strictObject({ operation: z.literal("resolve_url"), url: z.url() })
        .parse(await request.json());
      if (url === arxivPdf) {
        await answered;
        return new Response(
          readFileSync(join(fixtures, "zotero/resolve-arxiv.json")),
          {
            headers,
          },
        );
      }
      return new Response(
        readFileSync(join(fixtures, "zotero/resolve-unidentified.json")),
        {
          status: 422,
          headers,
        },
      );
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
    const response = await app.request("/capture-bytes", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    return CaptureResponseSchema.parse(await response.json()).key;
  };
  const own = await context.newPage();
  await page.bringToFront();
  try {
    await page.goto(`${app.origin}/`);
    await page.waitForSelector(
      '[role="status"][aria-label="Zotero is running with its local write API 3.7.0"]',
    );

    const key = await capture("lecture-notes.pdf", arxivPdf, "View PDF");
    await shownReader(key);
    expect(
      await page.$eval(tab(key), (element) => element.textContent),
    ).toContain("View PDF");
    await own.goto(`${app.origin}/read/${key}`);
    await own.waitForSelector(readerOf(key));
    answer();
    const title = "On The Cyclicity of Algebraic Lattices";
    await shows(tab(key), title);
    await own.waitForFunction(
      (wanted) =>
        document
          .querySelector('meta[name="citation_title"]')
          ?.getAttribute("content") === wanted && document.title === wanted,
      {},
      title,
    );
    await shot("zotero-retitled-reader");

    await capture(
      "problem-set.pdf",
      published("/~author/problems.pdf"),
      "Problem set",
    );
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
  const outlineShown = (css: string) => {
    const viewer = document.querySelector(css);
    if (viewer === null || viewer.shadowRoot === null) {
      return false;
    }
    return [...viewer.shadowRoot.querySelectorAll("span")].some(
      (entry) =>
        entry.textContent === "Gram matrices" && entry.checkVisibility(),
    );
  };
  const openOutlined = async () => {
    await page.goto(`${bucket.origin}/read/outlined`);
    await readerLoaded("outlined");
  };
  await openOutlined();
  expect(await page.evaluate(outlineShown, viewerOf("outlined"))).toBe(false);
  await shot("reader-outline-closed");

  const toggle =
    'button[role="switch"][aria-label="Open the outline when a PDF opens"]';
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
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "dark" },
  ]);

  expect(await libraryBackground()).toBe(LIBRARY.dark);
  expect(await viewerScheme()).toBe("dark");
  await shot("reader-dark");

  await libraryBackground();
  await page.select(themeSelect, "light");
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe(LIBRARY.light);
  expect(await viewerScheme()).toBe("light");
  expect(await libraryBackground()).toBe(LIBRARY.light);

  await page.select(themeSelect, "system");
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "system",
  );
  await page.emulateMediaFeatures();
});

test("night mode in the reader draws the PDF's pages light on dark, and turns off again", async () => {
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
  const margin = async () => {
    await readerLoaded("lattices");
    const corner = await firstPageCorner("lattices");
    return { x: corner.x + 4, y: corner.y + 4 };
  };
  const nightMode = readerButton("lattices", "night-mode");
  const toggleNightMode = async (pressed: boolean) => {
    await page.click(nightMode);
    await page.waitForSelector(
      pressed ? `${nightMode}${ACTIVE}` : `${nightMode}:not(${ACTIVE})`,
    );
  };
  await page.goto(`${bucket.origin}/read/lattices`);
  expect(await pixelAt(await margin())).toEqual([255, 255, 255]);

  await toggleNightMode(true);
  expect(await pixelAt(await margin())).toEqual([0, 0, 0]);
  expect((await organization()).preferences.readerNightMode).toBe(true);
  await shot("reader-night-mode");
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
  await page.click(readerButton("problems", "library"));
  await page.waitForSelector("nav a");

  await page.goto(`${bucket.origin}/read/problems`);
  expect(await notesOnFirstPage("problems")).toContain(note);
});

test("leaving the reader page while a note is still being saved asks first, and once it is saved leaves at once", async () => {
  await page.goto(`${bucket.origin}/read/lattices`);
  await readerLoaded("lattices");
  const held: HTTPRequest[] = [];
  let holding = true;
  let saving = () => {};
  const started = new Promise<void>((resolve) => {
    saving = resolve;
  });
  let inFlight = 0;
  const isSave = (request: HTTPRequest) =>
    request.method() === "PUT" &&
    request.url().endsWith("/api/items/lattices/pdf");
  const ended = (request: HTTPRequest) => {
    if (isSave(request)) {
      inFlight -= 1;
    }
  };
  const hold = (request: HTTPRequest) => {
    if (isSave(request)) {
      inFlight += 1;
    }
    if (holding && isSave(request)) {
      held.push(request);
      saving();
      return;
    }
    void request.continue();
  };
  const dialogs: string[] = [];
  const answer = (dialog: Dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  };
  page.on("dialog", answer);
  await page.setRequestInterception(true);
  page.on("request", hold);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  try {
    await writeNote("lattices", `A note on leaving ${Date.now()}`, 480);
    await started;
    const asked = new Promise<void>((resolve) =>
      page.once("dialog", () => resolve()),
    );
    await page.evaluate(() => {
      location.href = "/";
    });
    await asked;
    expect(dialogs).toEqual(["beforeunload"]);
    expect(new URL(page.url()).pathname).toBe("/read/lattices");

    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/lattices/pdf") &&
        response.request().method() === "PUT",
    );
    holding = false;
    for (const request of held.splice(0)) {
      await request.continue();
    }
    expect((await saved).status()).toBe(200);
    for (let quiet = 0; quiet < 4; quiet = inFlight === 0 ? quiet + 1 : 0) {
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    await page.evaluate(() => {
      location.href = "/";
    });
    await page.waitForSelector("nav a");
    expect(dialogs).toEqual(["beforeunload"]);
  } finally {
    page.off("request", hold);
    page.off("requestfinished", ended);
    page.off("requestfailed", ended);
    page.off("dialog", answer);
    await page.setRequestInterception(false);
  }
});

test("a right-click on selected text keeps the selection, and the highlight in its menu highlights it", async () => {
  await page.goto(`${bucket.origin}/read/problems`);
  await readerLoaded("problems");
  const corner = await firstPageCorner("problems");
  const at = (x: number, y: number) => ({
    x: corner.x + (x * corner.width) / 595,
    y: corner.y + (y * corner.width) / 595,
  });
  const start = at(150, 241);
  const end = at(320, 241);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  const selected = async () =>
    page.evaluate(async (css) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const selection = (await viewer?.registry)
        ?.getPlugin<SelectionPlugin>("selection")
        ?.provides();
      if (selection === undefined) {
        throw new Error(`${css} has no selection plugin`);
      }
      return selection.getFormattedSelection().length;
    }, viewerOf("problems"));
  expect(await selected()).toBeGreaterThan(0);

  const inside = at(230, 241);
  await page.mouse.click(inside.x, inside.y, { button: "right" });
  expect(await selected()).toBeGreaterThan(0);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/items/problems/pdf") &&
      response.request().method() === "PUT",
  );
  await page.click(
    inViewer("problems", '[data-epdf-i="add-highlight"] button'),
  );
  expect((await saved).status()).toBe(200);
  const highlights = await page.evaluate(
    async (css, highlight) => {
      const viewer = document.querySelector<EmbedPdfContainer>(css);
      const annotations = (await viewer?.registry)
        ?.getPlugin<AnnotationPlugin>("annotation")
        ?.provides();
      if (annotations === undefined) {
        throw new Error(`${css} has no annotation plugin`);
      }
      return (
        await annotations.getPageAnnotations({ pageIndex: 0 }).toPromise()
      ).filter((annotation) => annotation.type === highlight).length;
    },
    viewerOf("problems"),
    PdfAnnotationSubtype.HIGHLIGHT,
  );
  expect(highlights).toBe(1);
});

test("a note saved after a metadata write to the open PDF keeps that metadata, and the next save is taken too", async () => {
  const saved = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/items/lattices/pdf") &&
        response.request().method() === "PUT",
    );
  await page.goto(`${bucket.origin}/read/lattices`);
  await readerLoaded("lattices");
  const title = `Retitled while open ${Date.now()}`;
  const edited = await fetch(`${bucket.origin}/api/items/lattices/metadata`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      authors: ["Ada Researcher"],
      year: 2024,
      abstract: null,
    }),
  });
  expect(edited.status).toBe(200);

  const first = `Saved over new metadata ${Date.now()}`;
  const firstSave = saved();
  await writeNote("lattices", first);
  expect((await firstSave).status()).toBe(200);
  const second = `Saved after the rebase ${Date.now()}`;
  const secondSave = saved();
  await writeNote("lattices", second, 320);
  expect((await secondSave).status()).toBe(200);
  await page.click(readerButton("lattices", "library"));
  await page.waitForSelector("nav a");

  await page.goto(`${bucket.origin}/read/lattices`);
  const notes = await notesOnFirstPage("lattices");
  expect(notes).toContain(first);
  expect(notes).toContain(second);
  const payload = LibraryPayloadSchema.parse(
    await (await fetch(`${bucket.origin}/api/library`)).json(),
  );
  expect(payload.items.find((item) => item.id === "lattices")).toMatchObject({
    title,
    authors: ["Ada Researcher"],
    year: 2024,
  });
});

test("the reader records the last viewed page, the library shows it out of the page count, and the reader reopens there", async () => {
  await page.goto(`${bucket.origin}/read/reading`);
  await readerLoaded("reading");
  const recorded = page.waitForResponse((response) => {
    if (!response.url().endsWith("/api/items/reading/reading")) return false;
    const report = ReadingRequestSchema.safeParse(
      JSON.parse(response.request().postData() ?? "null"),
    );
    return report.success && report.data.page === 4 && report.data.pages === 10;
  });
  await goToPage("reading", 4);
  expect((await recorded).status()).toBe(200);

  await openLibrary();
  expect(
    await page.$eval(
      `${row("reading")} [data-reading]`,
      (cell) => cell.textContent,
    ),
  ).toBe("4 / 10");
  expect(
    await page.$eval(
      `${row("lattices")} [data-reading]`,
      (cell) => cell.textContent,
    ),
  ).toBe("Unread");
  await shot("library-reading");

  await page.goto(`${bucket.origin}/read/reading`);
  await readerLoaded("reading");
  await showsPage("reading", 4);
});

test("the reader records a change of zoom with the page shown, and opens again at that page and zoom", async () => {
  const reports: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/items/reading/reading")) {
      reports.push(JSON.parse(request.postData() ?? "null"));
    }
  });
  const reported = (wanted: (report: unknown) => boolean) =>
    page
      .waitForResponse(
        (response) =>
          response.url().endsWith("/api/items/reading/reading") &&
          wanted(JSON.parse(response.request().postData() ?? "null")),
        { timeout: 5000 },
      )
      .catch(() => undefined);
  await page.goto(`${bucket.origin}/read/reading`);
  await readerLoaded("reading");
  await new Promise((settled) => setTimeout(settled, 2000));
  expect(reports).toEqual([]);
  const paged = reported(
    (report) => z.object({ page: z.literal(4) }).safeParse(report).success,
  );
  await goToPage("reading", 4);
  await paged;
  const zoomed = reported(
    (report) => z.object({ zoom: z.literal(1.5) }).safeParse(report).success,
  );
  await zoomTo("reading", 1.5);
  await zoomed;
  const last = reports.at(-1);
  expect(last).toMatchObject({ zoom: 1.5 });
  const { page: recorded } = z.object({ page: z.int() }).parse(last);

  await page.goto(`${bucket.origin}/read/reading`);
  await readerLoaded("reading");
  await showsPage("reading", recorded);
  expect(await zoomOf("reading")).toBe(1.5);
});

test("in the reader Ctrl+F puts the cursor in the search field, and Enter and Shift+Enter step through the matches", async () => {
  await page.goto(`${bucket.origin}/read/reading`);
  await readerLoaded("reading");
  const field = inViewer(
    "reading",
    '[data-sidebar-id="search-panel"] input[type="text"]',
  );
  await page.keyboard.down("Control");
  await page.keyboard.press("f");
  await page.keyboard.up("Control");
  await page.waitForFunction(
    (css) => {
      const root = document.querySelector(css)?.shadowRoot;
      return (
        root?.activeElement?.matches(
          '[data-sidebar-id="search-panel"] input',
        ) === true
      );
    },
    {},
    viewerOf("reading"),
  );
  console.info("reader search test", { stage: "query" });
  await page.keyboard.type("unimodular");
  await showsPage("reading", 6);
  console.info("reader search test", { stage: "first-match", page: 6 });
  await page.keyboard.press("Enter");
  await showsPage("reading", 10);
  console.info("reader search test", { stage: "next-match", page: 10 });
  await page.keyboard.press("Enter");
  await showsPage("reading", 6);
  console.info("reader search test", { stage: "wrapped-match", page: 6 });
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
  await showsPage("reading", 10);
  console.info("reader search test", { stage: "previous-match", page: 10 });
  expect(
    await page.$eval(field, (input) => (input as HTMLInputElement).value),
  ).toBe("unimodular");
});

test("a PDF tab whose item left the bucket closes once Close Without Saving confirms the reading it cannot record", async () => {
  await openLibrary();
  const form = new FormData();
  const bytes = new Uint8Array([
    ...fixture("problem-set.pdf"),
    ...new TextEncoder().encode("% sent away while open\n"),
  ]);
  form.set("pdf", new File([bytes], "sent-away.pdf"));
  form.set("pdf_url", published("/~author/sent-away.pdf"));
  form.set("title_hint", "Sent away while open");
  const captured = await fetch(`${bucket.origin}/capture-bytes`, {
    method: "POST",
    body: form,
  });
  expect(captured.status).toBe(200);
  const key = CaptureResponseSchema.parse(await captured.json()).key;
  await shownReader(key);
  await Bun.sleep(6000);
  const deleted = await fetch(`${bucket.origin}/api/items/${key}`, {
    method: "DELETE",
  });
  expect(deleted.ok).toBe(true);

  await page.click(`${tab(key)} button[aria-label^="Close"]`);
  const dialog = await page.waitForSelector('[role="alertdialog"]', {
    visible: true,
  });
  expect(await dialog?.evaluate((element) => element.textContent)).toContain(
    `no stored PDF has key ${key}`,
  );
  await pressInDialog("Cancel");
  await page.waitForSelector('[role="alertdialog"]', { hidden: true });
  expect(await openTabKeys()).toContain(key);

  await page.click(`${tab(key)} button[aria-label^="Close"]`);
  await pressInDialog("Close Without Saving");
  await page.waitForFunction(`!document.querySelector('${tab(key)}')`);
}, 30_000);

test("the Timeline shows a reading session with the pages read for at least five seconds, and its title reopens the PDF in a tab", async () => {
  await page.goto(`${bucket.origin}/read/reading`);
  await readerLoaded("reading");
  for (const pageNumber of [1, 2]) {
    await goToPage("reading", pageNumber);
    await Bun.sleep(6000);
  }
  await goToPage("reading", 3);
  const reported = page.waitForResponse((response) =>
    response.url().endsWith("/api/reading-sessions"),
  );
  await page.click(readerButton("reading", "library"));
  expect((await reported).status()).toBe(200);
  await page.waitForSelector("nav a");

  await page.goto(`${bucket.origin}/#/timeline`);
  await page.waitForSelector('select[aria-label="Shortest reading"]');
  expect(await page.$('[data-timeline-key="reading"]')).toBeNull();
  await page.select('select[aria-label="Shortest reading"]', "5");
  const entry = await page.waitForSelector('[data-timeline-key="reading"]');
  expect(await entry?.evaluate((element) => element.textContent)).toContain(
    "pp. 1–2",
  );
  await shot("timeline");
  await page.click('[data-timeline-key="reading"] a');
  await shownReader("reading");
  expect(new URL(page.url()).pathname).toBe("/read/reading");
  await (await byRole("tab", "Library")).click();
  await page.waitForSelector('select[aria-label="Shortest reading"]', {
    visible: true,
  });
  expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe(
    "/#/timeline",
  );
});

test("the grid view shows each PDF's first page, and a double-click opens the reader in a tab", async () => {
  await openLibrary();
  const keys = (await rowKeys()).sort();
  await page.click('button[aria-label="Grid view"]');
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("[data-card-id] img").length === count &&
      [
        ...document.querySelectorAll<HTMLImageElement>("[data-card-id] img"),
      ].every((image) => image.complete && image.naturalWidth > 0),
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
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(
      'aside img[alt="First page"]',
    );
    return image !== null && image.naturalWidth > 0;
  });
  await page.click('[data-card-id="reading"]', { count: 2 });
  await shownReader("reading");

  await openRoot();
  await page.waitForSelector('[data-card-id="reading"]');
  await page.click('button[aria-label="List view"]');
  await page.waitForSelector(row("reading"));
});

test("rows chosen with their checkboxes are tagged and filed together", async () => {
  await api("POST", "/api/collections", { name: "Quadratic forms" });
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
  await page.waitForFunction(
    () => document.querySelector('[role="menu"]') === null,
  );

  const org = await organization();
  const forms = org.collections.find(
    (collection) => collection.name === "Quadratic forms",
  );
  for (const key of chosen) {
    expect(org.items[key]?.tags).toContain("survey");
    expect(org.items[key]?.collections).toContain(forms?.id ?? "");
  }
  expect(org.items.reading?.tags ?? []).not.toContain("survey");
  await page.click('button[aria-label="Clear selection"]');
  await page.waitForFunction(
    () => !document.body.textContent?.includes("selected"),
  );
});

test("Guess Metadata in the menu of a row outside the checked rows guesses that row; in a checked row, every checked row", async () => {
  const guessed: string[] = [];
  const answerGuess = (request: HTTPRequest) => {
    const guess = /^\/api\/items\/([^/]+)\/guess-metadata$/.exec(
      new URL(request.url()).pathname,
    );
    if (guess === null) {
      void request.continue();
      return;
    }
    guessed.push(decodeURIComponent(guess[1] ?? ""));
    void request.respond({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          kind: "metadata_guess_failed",
          message: "no model answers in this test",
        },
      }),
    });
  };
  const guessFrom = async (key: string) => {
    guessed.length = 0;
    await page.click(row(key), { button: "right" });
    await (await menuItem("Guess Metadata")).click();
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
    expect((await guessFrom("problems")).sort()).toEqual([
      "lattices",
      "problems",
    ]);
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
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"]') === null,
  );

  const folder = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-folder-"));
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
  expect(added?.provenance.pdf_url).toBe(
    pathToFileURL(join(folder, "folder notes.pdf")).href,
  );
});

test("the Related tab lists the PDFs that share authors, collections, topics or tags with the selected one", async () => {
  await fileInto("Quadratic forms", ["problems", "lattices"]);
  await api("POST", "/api/bulk/tags", {
    keys: ["problems", "notes"],
    add: ["survey"],
    remove: [],
  });
  await openLibrary();
  const org = await organization();
  const filing = (key: string) => [
    ...(org.items[key]?.collections ?? []),
    ...(org.items[key]?.tags ?? []),
  ];
  const sharing = Object.keys(org.items).filter(
    (key) =>
      key !== "problems" &&
      filing(key).some((entry) => filing("problems").includes(entry)),
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
  const kept = await page.$eval(
    'textarea[aria-label="New note"]',
    (field) => field.value,
  );
  expect(kept).toBe(draft);

  await (await byRole("button", "Add note")).click();
  await shows("aside article", draft);
  expect(
    await page.$eval('textarea[aria-label="New note"]', (field) => field.value),
  ).toBe("");
  expect(
    (await organization()).items.outlined?.notes.map((note) => note.note),
  ).toEqual([draft]);

  await page.click('button[aria-label="Delete note"]');
  await shot("note-delete-confirm");
  await (await byRole("button", "Cancel")).click();
  expect((await organization()).items.outlined?.notes).toHaveLength(1);
  await page.click('button[aria-label="Delete note"]');
  await (await byRole("button", "Delete note")).click();
  await page.waitForFunction(
    () => document.querySelector("aside article") === null,
  );
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
  await fileInto("Lattice theory", ["outlined"]);
  await fileInto("Quadratic forms", ["lattices", "problems"]);
  await page.goto(`${bucket.origin}/#/organization/collections`);
  await page.waitForSelector("[data-collection-id]");
  const org = await organization();
  const forms = org.collections.find(
    (collection) => collection.name === "Quadratic forms",
  );
  if (forms === undefined) {
    throw new Error("no Quadratic forms collection");
  }
  const held = Object.values(org.items).filter((filing) =>
    filing.collections.includes(forms.id),
  );
  const card = `[data-collection-id="${forms.id}"]`;
  expect(await page.$eval(card, (entry) => entry.textContent)).toContain(
    `${held.length} PDFs`,
  );
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
  await page.type(
    '[role="dialog"] input',
    "Genus theory and the Hasse–Minkowski theorem",
  );
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
  const saved = after.collections.find(
    (collection) => collection.id === forms.id,
  );
  expect([saved?.description, saved?.pinned, saved?.keepOffline]).toEqual([
    "Genus theory and the Hasse–Minkowski theorem",
    true,
    true,
  ]);
  expect(after.items[chosen]?.tags).toContain("topic:Genus theory");
  await page.click('button[aria-label="Clear selection"]');

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
  await fileInto("Quadratic forms", ["lattices", "problems"]);
  await markViewed("lattices", 2, 2);
  const payload = LibraryPayloadSchema.parse(
    await (await fetch(`${bucket.origin}/api/library`)).json(),
  );
  const forms = payload.collections.find(
    (collection) => collection.name === "Quadratic forms",
  );
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
  expect(either.length).toBeGreaterThan(both.length);

  await page.goto(`${bucket.origin}/#/organization/saved`);
  await (await page.waitForSelector('button[aria-label="Smart Collection"]'))?.click();
  await page.type(
    '[role="dialog"] input[aria-label="Name"]',
    "Unread quadratic forms",
  );
  await page.select(
    '[role="dialog"] select[aria-label="Rule 1 field"]',
    "collection",
  );
  await page.select(
    '[role="dialog"] select[aria-label="Rule 1 value"]',
    forms.id,
  );
  await page.click('[role="dialog"] button[aria-label="Add rule"]');
  await page.select(
    '[role="dialog"] select[aria-label="Rule 2 field"]',
    "reading",
  );
  await page.select(
    '[role="dialog"] select[aria-label="Rule 2 value"]',
    "unread",
  );
  await shot("dialog-smart-collection");
  await page.click('[role="dialog"] button[type="submit"]');
  await page.waitForFunction(() =>
    location.hash.startsWith("#/organization/saved/"),
  );
  const rowsNow = async (count: number) => {
    await page.waitForFunction(
      (wanted) =>
        document.querySelectorAll("tr[data-item-id]").length === wanted,
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
          source_kind: "document_structure",
          authoritative: true,
          command: [
            "sh",
            join(fixtures, "plugins/extractor.sh"),
            "hang",
            "$pdf",
            "$output",
          ],
          accepted_inputs: [
            { kind: "pdf", id: "pdf", label: "PDF", limits: [] },
          ],
        },
      ],
    }),
  );
  const slow = await serveBucket({
    root: mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-slow-")),
    zoteroUrl: closedPortUrl(),
    extractionsManifest: manifest,
    config: {
      ...config,
      plugins: { ...config.plugins, extraction_timeout_seconds: 1 },
    },
  });
  try {
    const form = new FormData();
    form.set("pdf", new File([fixture("problem-set.pdf")], "problems.pdf"));
    form.set("pdf_url", published("/~author/problems.pdf"));
    form.set("title_hint", "Problem set on quadratic forms");
    const response = await slow.request("/capture-bytes", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    const { key } = CaptureResponseSchema.parse(await response.json());
    await page.goto(`${slow.origin}/`);
    await page.waitForSelector(row(key));
    await page.click(row(key));
    const finished = page
      .waitForResponse(
        (response) =>
          response.url().endsWith(`/api/items/${key}/extractions/hang`) &&
          response.request().method() === "POST",
      )
      .then(() => performance.now());
    await page.click('button[aria-label="Run extraction"]');
    await shows(`${row(key)} [role="status"]`, "Extracting");
    const completedAt = await finished;
    await shows(
      "aside [role='alert']",
      "Slow extractor ran past its 1 s limit and was stopped; nothing was written",
    );
    expect(performance.now() - completedAt).toBeLessThan(10_000);
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
  const status = () =>
    page.$eval(`${row("problems")} [data-status]`, (cell) => cell.textContent);
  expect(await status()).toBe("Cached");
  await page.click(row("problems"));
  expect(await detailValue("Cache status")).toBe("Cached");
  const details = 'aside[aria-label="Item details"]';
  await page.click(`${details} button[aria-label="Verify sources"]`);
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.textContent === "Offline",
    {},
    `${row("problems")} [data-status]`,
  );
  expect(await detailValue("Cache status")).toBe("Offline");
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
  await page.click(row("problems"));
  expect(await detailValue("Cache status")).toBe("Cached");
  await shot("details-mirror");
});


test("the details show the selected PDF's first page", async () => {
  await openLibrary();
  const preview = 'aside[aria-label="Item details"] img[alt="First page"]';
  for (const [key] of CAPTURES) {
    await page.click(row(key));
    await page.waitForSelector(`${preview}[src*="/api/items/${key}/"]`);
    const started = performance.now();
    const drawn = await page
      .waitForFunction(
        (css) => {
          const image = document.querySelector<HTMLImageElement>(css);
          return image !== null && image.complete && image.naturalWidth > 0;
        },
        { timeout: 10_000 },
        preview,
      )
      .then(
        () => true,
        () => false,
      );
    console.info("first page preview", key, drawn, performance.now() - started);
    expect([key, drawn]).toEqual([key, true]);
  }
  await shot("details-first-page");
}, 90_000);
test("the details show the PDF's cache status, original SHA-256 and file path", async () => {
  await openLibrary();
  await page.click(row("lattices"));
  expect(await detailValue("Cache status")).toBe("Cached");
  expect(await detailValue("SHA-256")).toBe(
    sha256(fixture("lecture-notes.pdf")),
  );
  expect(await detailValue("File path")).toBe(
    join(bucket.root, "lattices", "lattices.pdf"),
  );
  await shot("details-identity");
});

test("the details header names each missing piece of metadata until it is recorded", async () => {
  const payload = await libraryPayload();
  const lattices = payload.items.find((item) => item.id === "lattices");
  expect([lattices?.authors, lattices?.year, lattices?.abstract]).toEqual([
    [],
    null,
    null,
  ]);
  await openLibrary();
  await page.click(row("lattices"));
  const header = 'aside[aria-label="Item details"] header';
  const headerText = () =>
    page.$eval(header, (element) => element.textContent ?? "");
  expect(await headerText()).toContain("No authors · No year");
  expect(await headerText()).toContain("No abstract");
  await shot("details-missing-metadata");

  await api("PATCH", "/api/items/lattices/metadata", {
    title: "Lectures on integral lattices",
    authors: ["A. Author", "B. Author"],
    year: 2019,
    abstract: null,
  });
  await shows(header, "A. Author, B. Author · 2019");
  expect(await headerText()).not.toContain("No authors");
  expect(await headerText()).not.toContain("No year");
  expect(await headerText()).toContain("No abstract");
});

test("a lost PDF the export holds is listed under Needs Re-fetch until Rebuild restores it", async () => {
  const exported = async () =>
    existsSync(bucket.indexExport)
      ? readFileSync(bucket.indexExport, "utf8")
      : "";
  while (!(await exported()).includes('"key": "lattices"')) {
    await Bun.sleep(50);
  }
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-away-"));
  renameSync(
    join(bucket.root, "lattices", "lattices.pdf"),
    join(away, "lattices.pdf"),
  );

  await openRoot();
  await page.waitForSelector('button[aria-label="Needs Re-fetch"]');
  await page.click('button[aria-label="Needs Re-fetch"]');
  await page.waitForFunction(() => location.hash === "#/needs-refetch");
  await page.waitForSelector('[data-missing-key="lattices"]');
  await shot("library-needs-refetch");
  await page.click(
    '[data-missing-key="lattices"] button[aria-label="Rebuild"]',
  );
  await page.waitForFunction(
    () => document.querySelector('[data-missing-key="lattices"]') === null,
  );

  await openLibrary();
  expect(await rowKeys()).toContain("lattices");
  expect(existsSync(join(bucket.root, "lattices", "lattices.pdf"))).toBe(true);
});

test("the Library entry counts the PDFs; each quick filter shows exactly the PDFs it names, says so when none match, and a second click clears it", async () => {
  await bucket.stop();
  await storeCapturedAt(
    bucket.root,
    "old",
    fixture("long-notes.pdf"),
    "2026-01-05T09:00:00Z",
  );
  served.set("/~author/old.pdf", fixture("long-notes.pdf"));
  bucket = await serveLibrary(bucket.root, bucket.indexExport);
  await fileInto("Quadratic forms", ["lattices"]);
  await markViewed("notes", 3, 10);
  served.delete("/~author/problems.pdf");
  await api("POST", "/api/items/problems/verify", {});
  const exported = () =>
    existsSync(bucket.indexExport)
      ? readFileSync(bucket.indexExport, "utf8")
      : "";
  while (!exported().includes('"key": "outlined"')) {
    await Bun.sleep(50);
  }
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-away-"));
  renameSync(
    join(bucket.root, "outlined", "outlined.pdf"),
    join(away, "outlined.pdf"),
  );

  const all = ["lattices", "notes", "old", "problems", "reading"];
  const filters = [
    {
      name: "Unread",
      hash: "#/unread",
      keys: ["lattices", "old", "problems", "reading"],
    },
    {
      name: "Unfiled",
      hash: "#/unfiled",
      keys: ["notes", "old", "problems", "reading"],
    },
    {
      name: "Added This Week",
      hash: "#/added-this-week",
      keys: ["lattices", "notes", "problems", "reading"],
    },
    { name: "Offline", hash: "#/offline", keys: ["problems"] },
  ];
  const sortedRows = async () => (await rowKeys()).sort();
  const rowCount = (count: number) =>
    page.waitForFunction(
      (wanted) =>
        document.querySelectorAll("tr[data-item-id]").length === wanted,
      {},
      count,
    );
  const chip = (name: string) => `button[aria-label="${name}"]`;
  const pressed = (name: string) =>
    page.$eval(chip(name), (button) => button.getAttribute("aria-pressed"));
  const chipText = (name: string) =>
    page.$eval(chip(name), (button) => button.textContent?.trim());
  const missingKeys = () =>
    page.$$eval("[data-missing-key]", (entries) =>
      entries.map((entry) => entry.getAttribute("data-missing-key")).sort(),
    );

  await openLibrary();
  await rowCount(all.length);
  expect(await page.$eval("nav a", (link) => link.textContent?.trim())).toBe(
    `Library${all.length}`,
  );
  for (const filter of filters) {
    expect(await chipText(filter.name)).toBe(
      `${filter.name}${filter.keys.length}`,
    );
    await page.click(chip(filter.name));
    await page.waitForFunction(
      (hash) => location.hash === hash,
      {},
      filter.hash,
    );
    await rowCount(filter.keys.length);
    expect(await sortedRows()).toEqual(filter.keys);
    expect(await pressed(filter.name)).toBe("true");
    expect(
      await page.$eval("nav a", (link) => link.getAttribute("aria-current")),
    ).toBe("page");
  }
  expect(await chipText("Needs Re-fetch")).toBe("Needs Re-fetch1");
  await page.click(chip("Needs Re-fetch"));
  await page.waitForFunction(() => location.hash === "#/needs-refetch");
  await page.waitForSelector('[data-missing-key="outlined"]');
  expect(await missingKeys()).toEqual(["outlined"]);
  await shot("library-quick-filter");

  await page.click(chip("Needs Re-fetch"));
  await rowCount(all.length);
  expect(await sortedRows()).toEqual(all);
  expect(await pressed("Needs Re-fetch")).toBe("false");

  await bucket.stop();
  const emptyRoot = mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-"));
  await storeCapturedAt(
    emptyRoot,
    "old",
    fixture("long-notes.pdf"),
    "2026-01-05T09:00:00Z",
  );
  rmSync(bucket.root, { recursive: true, force: true });
  rmSync(dirname(bucket.indexExport), { recursive: true, force: true });
  rmSync(away, { recursive: true, force: true });
  bucket = await serveLibrary(
    emptyRoot,
    join(
      mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-export-")),
      "index.json",
    ),
  );
  await fileInto("Quadratic forms", ["old"]);
  await markViewed("old", 2, 210);
  await page.goto(`${bucket.origin}/`);
  await page.waitForSelector(row("old"));
  for (const filter of filters) {
    expect(await chipText(filter.name)).toBe(`${filter.name}0`);
    await page.click(chip(filter.name));
    await page.waitForFunction(
      (hash) => location.hash === hash,
      {},
      filter.hash,
    );
    await rowCount(0);
    expect(
      await page.$eval("table tbody", (body) => body.textContent?.trim()),
    ).toBe(`No PDF matches ${filter.name}`);
  }
  await shot("library-quick-filter-empty");
  await page.click(chip("Needs Re-fetch"));
  await page.waitForFunction(() => location.hash === "#/needs-refetch");
  await shows("main", "Every PDF is in the library.");
  expect(await missingKeys()).toEqual([]);
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
  await page.waitForFunction(
    () => document.querySelector('[role="menu"]') === null,
  );
  await page.click('button[aria-label="Sort"]');
  await (await byRole("menuitemradio", "Ascending")).click();
  await shot("library-sorted");
  expect(await titles()).toEqual(expected);

  await page.click('button[aria-label="Sort"]');
  await (await byRole("menuitemradio", "Descending")).click();
  expect(await titles()).toEqual([...expected].reverse());
});

test("the list and the reader's assistant pane show whether a PDF has an extraction, and the pane runs one", async () => {
  const manifest = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-manifest-")),
    "extractions.json",
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      plugins: [
        {
          id: "markdown",
          name: "Markdown extractor",
          source_kind: "document_structure",
          authoritative: true,
          command: [
            "sh",
            join(fixtures, "plugins/extractor.sh"),
            "markdown",
            "$pdf",
            "$output",
          ],
          accepted_inputs: [
            { kind: "pdf", id: "pdf", label: "PDF", limits: [] },
          ],
        },
      ],
    }),
  );
  const bucket = await serveBucket({
    root: mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-extract-")),
    zoteroUrl: closedPortUrl(),
    extractionsManifest: manifest,
    config: loadAppConfig(CONFIG_PATH),
  });
  try {
    const form = new FormData();
    form.set("pdf", new File([fixture("problem-set.pdf")], "problems.pdf"));
    form.set("pdf_url", published("/~author/problems.pdf"));
    form.set("title_hint", "Problem set on quadratic forms");
    const { key } = CaptureResponseSchema.parse(
      await (
        await bucket.request("/capture-bytes", { method: "POST", body: form })
      ).json(),
    );
    await page.goto(`${bucket.origin}/`);
    await page.waitForSelector(row(key));
    expect(await page.$(`${row(key)} [data-extraction]`)).toBeNull();

    await page.click(row(key), { count: 2 });
    await shownReader(key);
    await page.click('button[aria-label="Open the assistant"]');
    await shows(
      'section[aria-label="Extraction"]',
      "No extraction: the assistant reads the raw PDF",
    );
    await shot("reader-no-extraction");
    const finished = page
      .waitForResponse(
        (response) =>
          response.url().endsWith(`/api/items/${key}/extractions/markdown`) &&
          response.request().method() === "POST",
      )
      .then(() => performance.now());
    await page.click(
      'section[aria-label="Extraction"] button[aria-label="Run extraction"]',
    );
    const completedAt = await finished;
    await shows(
      'section[aria-label="Extraction"]',
      "Extracted: the assistant reads the extraction",
    );
    expect(performance.now() - completedAt).toBeLessThan(10_000);
    await shot("reader-extracted");

    await page.click('button[aria-label="Collapse the assistant"]');
    await page.waitForSelector('aside [role="status"][title="Extracted"]');
    await page.click('[role="tab"]:first-of-type');
    await page.waitForSelector(`${row(key)} [data-extraction]`, {
      visible: true,
    });
    await shot("library-extracted");
  } finally {
    await bucket.stop();
  }
});

const inspectorAlert = 'aside[aria-label="Item details"] [role="alert"]';
const inspectorSend = () => byRole("button", "Send to Zotero");
const runCommand = async (name: string) => {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("p");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
};

test("a send while Zotero is not running shows why in the details, from every control, and the paper still opens", async () => {
  await openLibrary();
  await page.click(row("lattices"));
  await (await inspectorSend()).click();
  await shows(inspectorAlert, "Zotero is not running: start Zotero");
  await shot("send-zotero-not-running");
  expect(
    await (await inspectorSend()).evaluate(
      (button) => (button as HTMLButtonElement).disabled,
    ),
  ).toBe(false);
  await (await byRole("button", "Open")).click();
  await shownReader("lattices");
  await page.click('[role="tab"]:first-of-type');

  await page.click(row("problems"), { button: "right" });
  await (await menuItem("Send to Zotero")).click();
  await page.click(row("problems"));
  await shows(inspectorAlert, "Zotero is not running: start Zotero");

  await page.click(row("notes"));
  await runCommand("Send Selected PDF to Zotero");
  await shows(inspectorAlert, "Zotero is not running: start Zotero");
  expect(await rowKeys()).toEqual(
    expect.arrayContaining(["lattices", "problems", "notes"]),
  );
});

test("each send control sends its way and names where the paper went in Zotero: the details menu, the details pane's button, the row and tab context menus and the palette", async () => {
  const zotero = zoteroStub();
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-send-ui-"));
  const manifest = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-send-ui-manifest-")),
    "extractions.json",
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      plugins: ["quota", "broken"].map((id) => ({
        id,
        name: `Failing extractor ${id}`,
        source_kind: "document_structure",
        authoritative: true,
        command: [
          "sh",
          join(fixtures, "plugins/extractor.sh"),
          "fail",
          "$pdf",
          "$output",
        ],
        accepted_inputs: [{ kind: "pdf", id: "pdf", label: "PDF", limits: [] }],
      })),
    }),
  );
  const config = loadAppConfig(CONFIG_PATH);
  const app = await serveBucket({
    root,
    zoteroUrl: zotero.url,
    extractionsManifest: manifest,
    config: {
      ...config,
      plugins: { ...config.plugins, send_extraction_chain: ["quota", "broken"] },
    },
  });
  try {
    for (const [key, bytes, linkText] of CAPTURES) {
      const form = new FormData();
      form.set("pdf", new File([bytes], `${key}.pdf`));
      form.set("pdf_url", published(`/~author/${key}.pdf`));
      form.set("title_hint", linkText);
      expect(
        (await app.request("/capture-bytes", { method: "POST", body: form })).ok,
      ).toBe(true);
    }
    const message = (role: "alert" | "status") => `main > [role="${role}"]`;
    zotero.selection = { kind: "collection", key: "LATT2345", name: "Lattices" };
    await page.goto(`${app.origin}/`);
    await page.waitForSelector(row("lattices"));

    await page.click(row("lattices"));
    await page.click('button[aria-label="Other sends"]');
    await (await menuItem("Send to Zotero and Extract")).click();
    const failed = "Sent to Zotero in the collection “Lattices”, but no plugin extracted the PDF";
    await shows(message("alert"), failed);
    await shows(message("alert"), "quota: exited with code 3");
    await shows(message("alert"), "broken: exited with code 3");
    await shot("send-extract-all-failed");
    await page.waitForSelector(row("lattices"), { hidden: true });

    await page.click(row("outlined"));
    await shows(message("alert"), failed);
    for (const width of [viewport.width, 1024]) {
      await page.setViewport({ ...viewport, width });
      for (const button of [await byRole("button", "Open"), await inspectorSend()]) {
        expect(
          await button.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return hit !== null && element.contains(hit);
          }),
        ).toBe(true);
      }
      await shot(`send-extract-failed-inspector-usable-${width}`);
    }
    await page.setViewport(viewport);
    zotero.selection = { kind: "library_root" };
    await (await inspectorSend()).click();
    await shows(message("status"), "Sent to Zotero in My Library");
    await page.waitForSelector(row("outlined"), { hidden: true });

    zotero.selection = { kind: "collection", key: "FORM2345", name: "Quadratic forms" };
    await page.click(row("problems"), { button: "right" });
    await (await menuItem("Send PDF Only to Zotero")).click();
    await shows(
      message("status"),
      "Sent the PDF to Zotero as a standalone attachment in the collection “Quadratic forms”",
    );
    await page.waitForSelector(row("problems"), { hidden: true });

    zotero.selection = { kind: "library_root" };
    await page.click(row("notes"), { count: 2 });
    await shownReader("notes");
    await page.click(tab("notes"), { button: "right" });
    await (await menuItem("Send to Zotero")).click();
    await shows(message("status"), "Sent to Zotero in My Library");
    await page.waitForSelector(tab("notes"), { hidden: true });
    await page.waitForSelector(row("notes"), { hidden: true });

    zotero.refuse = (request) =>
      request.path === "/attach" && String(request.body?.file_name).endsWith(".pdf")
        ? refusal(500, "attach_file_to_item", "Disk full", request.body)
        : null;
    await page.click(row("reading"));
    await runCommand("Send Selected PDF to Zotero");
    await shows(inspectorAlert, "Disk full");
    zotero.refuse = null;
    await runCommand("Send Selected PDF to Zotero");
    await shows(message("status"), "Already in Zotero from an earlier send");
    await shot("send-earlier-send-named");
    await page.waitForSelector(row("reading"), { hidden: true });

    const items = [...zotero.items.values()];
    expect(items.map((held) => held.url).sort()).toEqual(
      ["lattices", "outlined", "notes", "reading"]
        .map((key) => published(`/~author/${key}.pdf`))
        .sort(),
    );
    for (const held of items) {
      expect(
        zotero.children(held.key).map((child) => child.data.contentType),
      ).toEqual(["application/pdf"]);
    }
    expect(zotero.standalone.map((child) => child.data.filename)).toHaveLength(1);
  } finally {
    await app.stop();
    zotero.stop();
  }
}, 120_000);

const showView = async (hash: string, count: number) => {
  await page.evaluate((target) => {
    location.hash = target;
  }, hash);
  await page.waitForFunction(
    (target, wanted) =>
      location.hash === target &&
      document.querySelectorAll("tr[data-item-id]").length === wanted,
    {},
    hash,
    count,
  );
  return (await rowKeys()).sort();
};
const tableText = () =>
  page.$eval("table tbody", (body) => body.textContent?.trim());
const newSavedSearch = async (
  name: string,
  rule: Record<string, string>,
) =>
  z
    .object({ id: z.string() })
    .parse(
      await (
        await api("POST", "/api/saved-searches", {
          name,
          match: "all",
          rules: [rule],
        })
      ).json(),
    ).id;

test("smart collections with title, author and tag rules follow each edit made in the details pane", async () => {
  const byTitle = await newSavedSearch("Quadratic titles", {
    field: "title",
    operator: "contains",
    value: "quadratic",
  });
  const byAuthor = await newSavedSearch("By Noether", {
    field: "author",
    operator: "contains",
    value: "Noether",
  });
  const byTag = await newSavedSearch("Survey papers", {
    field: "tag",
    operator: "is",
    value: "survey",
  });
  const titled = (await libraryPayload()).items
    .filter((item) => item.title.toLowerCase().includes("quadratic"))
    .map((item) => item.id)
    .sort();
  expect(titled).not.toContain("lattices");
  const withLattices = [...titled, "lattices"].sort();

  await openLibrary();
  expect(await showView(`#/organization/saved/${byTitle}`, titled.length)).toEqual(titled);
  expect(await showView(`#/organization/saved/${byAuthor}`, 0)).toEqual([]);
  expect(await showView(`#/organization/saved/${byTag}`, 0)).toEqual([]);

  await showView("#/", CAPTURES.length);
  await page.click(row("lattices"));
  await page.click('button[aria-label="Edit metadata"]');
  await page.click('input[aria-label="Title"]', { count: 3 });
  await page.keyboard.press("Backspace");
  await page.type('input[aria-label="Title"]', "Quadratic forms on integral lattices");
  await (await byRole("button", "Save metadata")).click();
  await shows("aside h2", "Quadratic forms on integral lattices");
  expect(
    await showView(`#/organization/saved/${byTitle}`, withLattices.length),
  ).toEqual(withLattices);
  expect(await showView(`#/organization/saved/${byAuthor}`, 0)).toEqual([]);

  await showView("#/", CAPTURES.length);
  await page.click(row("lattices"));
  await page.click('button[aria-label="Edit metadata"]');
  await page.type('textarea[aria-label="Authors, one per line"]', "Emmy Noether");
  await (await byRole("button", "Save metadata")).click();
  await shows("aside header", "Emmy Noether");
  expect(await showView(`#/organization/saved/${byAuthor}`, 1)).toEqual([
    "lattices",
  ]);

  await showView("#/", CAPTURES.length);
  await page.click(row("lattices"));
  await page.click('button[aria-label="Add tag"]');
  await page.type('input[aria-label="Tag"]', "survey");
  await page.keyboard.press("Enter");
  await page.waitForSelector('aside button[aria-label="Remove survey"]');
  expect(await showView(`#/organization/saved/${byTag}`, 1)).toEqual([
    "lattices",
  ]);
  await shot("smart-collection-follows-edits");

  await showView("#/", CAPTURES.length);
  await page.click(row("lattices"));
  await page.click('aside button[aria-label="Remove survey"]');
  await page.waitForSelector('aside button[aria-label="Remove survey"]', {
    hidden: true,
  });
  expect(await showView(`#/organization/saved/${byTag}`, 0)).toEqual([]);
  expect(await tableText()).toBe("No PDF matches Survey papers");
}, 60_000);

test("a tag on the Tags page lists exactly the PDFs that carry it", async () => {
  await api("POST", "/api/bulk/tags", {
    keys: ["lattices", "problems"],
    add: ["survey"],
    remove: [],
  });
  await api("POST", "/api/bulk/tags", {
    keys: ["notes"],
    add: ["exercises"],
    remove: [],
  });
  await page.goto(`${bucket.origin}/#/organization/tags`);
  await (
    await page.waitForSelector('a[href$="/organization/tags/survey"]')
  )?.click();
  await page.waitForFunction(
    () => location.hash === "#/organization/tags/survey",
  );
  await page.waitForFunction(
    () => document.querySelectorAll("tr[data-item-id]").length === 2,
  );
  expect((await rowKeys()).sort()).toEqual(["lattices", "problems"]);
  await shot("tag-page");
});

test("a PDF in two collections shows in both and not in Unfiled; once removed from both it shows in Unfiled", async () => {
  const algebra = await fileInto("Algebra", ["lattices"]);
  const geometry = await fileInto("Geometry", ["lattices"]);
  const unfiled = ["notes", "outlined", "problems", "reading"];
  await openLibrary();
  expect(
    await showView(`#/organization/collections/${algebra}`, 1),
  ).toEqual(["lattices"]);
  expect(
    await showView(`#/organization/collections/${geometry}`, 1),
  ).toEqual(["lattices"]);
  expect(await showView("#/unfiled", unfiled.length)).toEqual(unfiled);

  await showView("#/", CAPTURES.length);
  await page.click(row("lattices"));
  for (const name of ["Algebra", "Geometry"]) {
    await page.click(`aside button[aria-label="Remove ${name}"]`);
    await page.waitForSelector(`aside button[aria-label="Remove ${name}"]`, {
      hidden: true,
    });
  }
  expect(await showView(`#/organization/collections/${algebra}`, 0)).toEqual([]);
  expect(await tableText()).toBe("No PDF matches Algebra");
  const all = ["lattices", ...unfiled].sort();
  expect(await showView("#/unfiled", all.length)).toEqual(all);
});

test("a saved search whose tag left its last PDF stays and opens empty", async () => {
  await api("POST", "/api/bulk/tags", {
    keys: ["problems"],
    add: ["survey"],
    remove: [],
  });
  const search = await newSavedSearch("Survey papers", {
    field: "tag",
    operator: "is",
    value: "survey",
  });
  await openLibrary();
  expect(await showView(`#/organization/saved/${search}`, 1)).toEqual([
    "problems",
  ]);
  await page.click(row("problems"));
  await page.click('aside button[aria-label="Remove survey"]');
  await page.waitForSelector('aside button[aria-label="Remove survey"]', {
    hidden: true,
  });
  expect(await showView(`#/organization/saved/${search}`, 0)).toEqual([]);
  expect(await tableText()).toBe("No PDF matches Survey papers");
  expect(await page.$('[role="alert"]')).toBeNull();
  await shot("saved-search-tag-gone");

  await page.reload();
  await shows("table tbody", "No PDF matches Survey papers");
  expect(await rowKeys()).toEqual([]);
  const kept = (await libraryPayload()).savedSearches.find(
    (saved) => saved.id === search,
  );
  expect(kept?.rules).toEqual([
    { field: "tag", operator: "is", value: "survey" },
  ]);
});

test("a failed library load shows the alert with Reload; an empty library says No PDFs yet with no alert", async () => {
  let failing = true;
  const failLoad = (request: HTTPRequest) => {
    if (failing && new URL(request.url()).pathname === "/api/library") {
      void request.respond({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { kind: "internal", message: "the store is unreadable in this test" },
        }),
      });
      return;
    }
    void request.continue();
  };
  await page.setRequestInterception(true);
  page.on("request", failLoad);
  try {
    await page.goto(`${bucket.origin}/`);
    await shows('[role="alert"] h1', "The library could not be loaded");
    await shot("library-load-failed");
    failing = false;
    await (await byRole("button", "Reload the library")).click();
    await page.waitForSelector(row("lattices"));
    expect(await page.$('[role="alert"]')).toBeNull();
  } finally {
    page.off("request", failLoad);
    await page.setRequestInterception(false);
  }

  await bucket.stop();
  rmSync(bucket.root, { recursive: true, force: true });
  rmSync(dirname(bucket.indexExport), { recursive: true, force: true });
  bucket = await serveLibrary(
    mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-")),
    join(
      mkdtempSync(join(tmpdir(), "pdf-bucket-library-e2e-export-")),
      "index.json",
    ),
  );
  await page.goto(`${bucket.origin}/`);
  await shows("main", "No PDFs yet");
  expect(await page.$('[role="alert"]')).toBeNull();
  await shot("library-empty");
});
