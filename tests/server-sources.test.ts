// Source checks, mirror URLs and rebuilding lost PDFs, through the real server and store
// against a local publisher whose responses the tests change.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CaptureResponseSchema } from "../src/contract/capture";
import {
  ApiErrorSchema,
  ArxivPromotionResponseSchema,
  ArxivSearchResponseSchema,
  type BucketItem,
  LibraryPayloadSchema,
  RebuildOutcomeSchema,
} from "../src/contract/library";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";
import { recoveryCases } from "./fixtures/recovery-cases";
import { listItems, readIndexExport, recordMetadata } from "./store";

setDefaultTimeout(30_000);

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));
const lectureNotes = fixture("lecture-notes.pdf");
const problemSet = fixture("problem-set.pdf");
const outlinedNotes = fixture("outlined-notes.pdf");
const discoveryCorpus: { id: string; title: string; authors: string[] }[] =
  JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/arxiv-corpus.json"), "utf8"),
  );
const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const corpusFeed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${discoveryCorpus
  .map(
    (entry) =>
      `<entry><id>${xml(entry.id)}</id><title>${xml(entry.title)}</title>${entry.authors
        .map((author) => `<author><name>${xml(author)}</name></author>`)
        .join("")}</entry>`,
  )
  .join("")}</feed>`;

// The publisher: what each path serves right now; a path with nothing serves 404.
const served = new Map<string, Uint8Array<ArrayBuffer>>();
let atomFeed: string | undefined;
let pdfRedirect: string | undefined;
const publisher = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/query") {
      return new Response(
        atomFeed ??
          `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1234.5678v1</id>
    <title>Promotion Notes</title>
    <summary>Notes used to verify source promotion.</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>An Author</name></author>
  </entry>
</feed>`,
        { headers: { "Content-Type": "application/atom+xml" } },
      );
    }
    if (url.pathname === "/pdf/1234.5678v1" && pdfRedirect !== undefined) {
      return Response.redirect(pdfRedirect);
    }
    const bytes = served.get(url.pathname);
    return bytes === undefined
      ? new Response("not found", { status: 404 })
      : new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
  },
});
afterAll(() => publisher.stop(true));
const at = (path: string) => new URL(path, publisher.url).href;

async function bucket(
  indexExport: string | null,
  config = loadAppConfig(CONFIG_PATH),
  manifest = EXTRACTIONS_MANIFEST,
  env?: Record<string, string>,
) {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-sources-"));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: manifest,
    config,
    env,
    ...(indexExport === null ? {} : { indexExport }),
  });
  const request = (method: string, path: string, body?: object) =>
    app.request(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const capture = async (
    bytes: Uint8Array<ArrayBuffer>,
    key: string,
    pdfUrl: string,
  ) => {
    const form = new FormData();
    form.set(
      "pdf",
      new File([bytes], `${key}.pdf`, { type: "application/pdf" }),
    );
    form.set("pdf_url", pdfUrl);
    form.set("title_hint", `Notes ${key}`);
    const response = await app.request("/capture-bytes", {
      method: "POST",
      body: form,
    });
    expect(CaptureResponseSchema.parse(await response.json())).toMatchObject({
      key,
      existing: false,
      provenance: { pdf_url: pdfUrl },
    });
  };
  const library = async () =>
    LibraryPayloadSchema.parse(
      await (await request("GET", "/api/library")).json(),
    );
  const item = async (key: string): Promise<BucketItem> => {
    const found = (await library()).items.find(
      (candidate) => candidate.id === key,
    );
    if (found === undefined) {
      throw new Error(`the library lists no item ${key}`);
    }
    return found;
  };
  return { root, app, request, capture, library, item };
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline)
      throw new Error(`promotion did not reach ${path}`);
    await Bun.sleep(10);
  }
}

async function discoveredCandidate(
  root: string,
  key: string,
  request: (method: string, path: string, body?: object) => Promise<Response>,
) {
  await recordMetadata(root, key, "resolver", {
    title: "Promotion Notes",
    authors: ["An Author"],
    year: 2024,
  });
  const search = ArxivSearchResponseSchema.parse(
    await (await request("POST", `/api/items/${key}/arxiv`)).json(),
  );
  const candidate = search.matches[0];
  if (candidate === undefined)
    throw new Error("the fixture candidate did not match");
  return candidate;
}

test("Verify records whether the PDF URL and each mirror still serve the captured bytes", async () => {
  served.set("/notes/verified.pdf", lectureNotes);
  served.set("/mirror/verified.pdf", lectureNotes);
  const { request, capture, item } = await bucket(null);
  await capture(lectureNotes, "verified", at("/notes/verified.pdf"));
  expect((await item("verified")).sourceCheck).toEqual({ status: "unchecked" });

  await request("POST", "/api/items/verified/mirrors", {
    url: at("/mirror/verified.pdf"),
  });
  await request("POST", "/api/items/verified/mirrors", {
    url: at("/gone/verified.pdf"),
  });
  await request("POST", "/api/items/verified/verify");
  const checked = await item("verified");
  expect(checked.sourceCheck).toMatchObject({ status: "accessible" });
  expect(
    checked.mirrors.map((mirror) => [mirror.url, mirror.check.status]),
  ).toEqual([
    [at("/mirror/verified.pdf"), "accessible"],
    [at("/gone/verified.pdf"), "dead"],
  ]);

  served.set("/notes/verified.pdf", problemSet);
  await request("POST", "/api/items/verified/verify");
  expect((await item("verified")).sourceCheck).toMatchObject({
    status: "changed",
  });
  served.delete("/notes/verified.pdf");
  await request("POST", "/api/items/verified/verify");
  expect((await item("verified")).sourceCheck).toMatchObject({
    status: "dead",
  });

  await request(
    "DELETE",
    `/api/items/verified/mirrors?url=${encodeURIComponent(at("/gone/verified.pdf"))}`,
  );
  expect((await item("verified")).mirrors.map((mirror) => mirror.url)).toEqual([
    at("/mirror/verified.pdf"),
  ]);
  const notUrl = await request("POST", "/api/items/verified/mirrors", {
    url: "not a url",
  });
  expect(ApiErrorSchema.parse(await notUrl.json()).error.kind).toBe(
    "invalid_request",
  );
  expect(
    ApiErrorSchema.parse(
      await (await request("POST", "/api/items/missing/verify")).json(),
    ).error.kind,
  ).toBe("unknown_item");
});

test("arXiv promotion rejects a candidate whose PDF is not hosted by arXiv", async () => {
  const { request, capture } = await bucket(null);
  await capture(lectureNotes, "ordinary", at("/notes/ordinary.pdf"));

  const response = await request("POST", "/api/items/ordinary/arxiv/promote", {
    id: "1234.5678",
    version: "1",
    title: "A paper",
    authors: ["An Author"],
    abstract: null,
    year: 2024,
    score: 1,
    absUrl: "https://arxiv.org/abs/1234.5678",
    pdfUrl: at("/notes/ordinary.pdf"),
    reasons: ["title 100%"],
  });

  expect(response.status).toBe(400);
  expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe(
    "invalid_request",
  );
});

test("a forged confidence score cannot promote an unrelated arXiv candidate", async () => {
  served.set("/pdf/1234.5678", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(null, localArxiv);
  await capture(lectureNotes, "unrelated", at("/notes/unrelated.pdf"));
  await recordMetadata(root, "unrelated", "resolver", {
    title: "Entirely unrelated",
    authors: ["Other Author"],
    year: 2024,
  });
  const response = await request("POST", "/api/items/unrelated/arxiv/promote", {
    id: "1234.5678",
    version: "1",
    title: "Entirely unrelated",
    authors: ["Other Author"],
    abstract: null,
    year: 2024,
    score: 1,
    absUrl: at("/abs/1234.5678"),
    pdfUrl: "https://arxiv.org/pdf/1234.5678v1",
    reasons: ["title 100%"],
  });
  expect(response.status).toBe(400);
  expect((await library()).items).toHaveLength(1);
});

test("confident arXiv promotion preserves the original and is idempotent", async () => {
  served.set("/notes/promotion.pdf", lectureNotes);
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library, item } = await bucket(
    null,
    localArxiv,
  );
  await capture(lectureNotes, "000-original", at("/notes/promotion.pdf"));
  await recordMetadata(root, "000-original", "resolver", {
    title: "Promotion Notes",
    authors: ["An Author"],
    year: 2024,
  });
  const originalBefore = (await listItems(root, ["000-original"]))[0]
    ?.provenance;
  expect(originalBefore).toBeDefined();

  const search = ArxivSearchResponseSchema.parse(
    await (await request("POST", "/api/items/000-original/arxiv")).json(),
  );
  const candidate = search.matches[0];
  expect(candidate).toBeDefined();
  const [firstResponse, secondResponse] = await Promise.all([
    request("POST", "/api/items/000-original/arxiv/promote", candidate),
    request("POST", "/api/items/000-original/arxiv/promote", candidate),
  ]);
  const results = [
    ArxivPromotionResponseSchema.parse(await firstResponse.json()),
    ArxivPromotionResponseSchema.parse(await secondResponse.json()),
  ];
  const first = results.find((result) => !result.existing);
  const second = results.find((result) => result.existing);
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  if (first === undefined || second === undefined)
    throw new Error("promotion was not idempotent");
  expect(first.existing).toBe(false);
  expect(first.sourceLineage.originalKey).toBe("000-original");
  expect(first.sourceLineage.preferredKey).toBe(first.key);

  const originalAfter = await item("000-original");
  const preferred = await item(first.key);
  expect(originalAfter.provenance).toEqual(originalBefore);
  expect(originalAfter.sourceLineage).toEqual(preferred.sourceLineage);
  expect(preferred.provenance.pdf_url).toBe(
    "https://arxiv.org/pdf/1234.5678v1",
  );
  expect((await library()).items).toHaveLength(2);

  expect(second).toMatchObject({ existing: true, key: first.key });
  expect((await library()).items).toHaveLength(2);
});

test("simultaneous promotions from separate server processes reuse one preferred item", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(null, localArxiv);
  await capture(lectureNotes, "cross-process", at("/notes/cross-process.pdf"));
  const candidate = await discoveredCandidate(root, "cross-process", request);
  const second = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    config: localArxiv,
  });
  try {
    const [first, other] = await Promise.all([
      request("POST", "/api/items/cross-process/arxiv/promote", candidate),
      second.request("/api/items/cross-process/arxiv/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      }),
    ]);
    expect(first.status).toBe(200);
    expect(other.status).toBe(200);
    const results = [
      ArxivPromotionResponseSchema.parse(await first.json()),
      ArxivPromotionResponseSchema.parse(await other.json()),
    ];
    expect(results[0]?.key).toBe(results[1]?.key);
    expect(results.map((result) => result.existing).sort()).toEqual([
      false,
      true,
    ]);
    expect((await library()).items).toHaveLength(2);
  } finally {
    await second.stop();
  }
});

test("promotion lineage is recoverable from the preferred PDF without the filing document", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, item } = await bucket(null, localArxiv);
  await capture(
    lectureNotes,
    "lineage-original",
    at("/notes/lineage-original.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "lineage-original",
    request,
  );
  const response = await request(
    "POST",
    "/api/items/lineage-original/arxiv/promote",
    candidate,
  );
  const promoted = ArxivPromotionResponseSchema.parse(await response.json());
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-filing-away-"));
  if (existsSync(join(root, "organization.json"))) {
    renameSync(
      join(root, "organization.json"),
      join(away, "organization.json"),
    );
  }
  expect((await item("lineage-original")).sourceLineage).toEqual(
    promoted.sourceLineage,
  );
  expect((await item(promoted.key)).sourceLineage).toEqual(
    promoted.sourceLineage,
  );
  const repeated = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/lineage-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  expect(repeated).toMatchObject({ existing: true, key: promoted.key });
});

test("saving a preferred PDF preserves its source lineage when the editor omits it", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, app, request, capture, item } = await bucket(null, localArxiv);
  await capture(lectureNotes, "save-original", at("/notes/save-original.pdf"));
  const candidate = await discoveredCandidate(root, "save-original", request);
  const promoted = ArxivPromotionResponseSchema.parse(
    await (
      await request("POST", "/api/items/save-original/arxiv/promote", candidate)
    ).json(),
  );
  const pdf = await app.request(`/pdf/${promoted.key}.pdf`);
  const tag = pdf.headers.get("etag");
  if (tag === null) throw new Error("the PDF has no entity tag");
  const saved = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-editor-")),
    "saved.pdf",
  );
  const editor = Bun.spawn(
    [
      "uv",
      "run",
      "--locked",
      "python",
      "-c",
      "import pikepdf,sys; p=pikepdf.open(sys.argv[1]); del p.docinfo['/PDFBucketSourceLineage']; p.save(sys.argv[2])",
      join(root, `${promoted.key}.pdf`),
      saved,
    ],
    { stderr: "pipe" },
  );
  const error = await new Response(editor.stderr).text();
  if ((await editor.exited) !== 0) throw new Error(error);
  const response = await app.request(`/api/items/${promoted.key}/pdf`, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf", "If-Match": tag },
    body: new Uint8Array(readFileSync(saved)),
  });
  expect(response.status).toBe(200);
  expect((await item("save-original")).sourceLineage).toEqual(
    promoted.sourceLineage,
  );
  expect((await item(promoted.key)).sourceLineage).toEqual(
    promoted.sourceLineage,
  );
});

test("rebuilding a lost preferred PDF restores its lineage", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    rebuild: { ...config.rebuild, download_timeout_seconds: 1 },
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const exportFile = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-promotion-export-")),
    "index.json",
  );
  const { root, request, capture, item } = await bucket(exportFile, localArxiv);
  await capture(
    lectureNotes,
    "rebuild-original",
    at("/notes/rebuild-original.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "rebuild-original",
    request,
  );
  const promoted = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/rebuild-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  expect(
    (
      await request("POST", `/api/items/${promoted.key}/mirrors`, {
        url: at("/pdf/1234.5678v1"),
      })
    ).status,
  ).toBe(200);
  const deadline = Date.now() + 10_000;
  while (
    !readIndexExport(exportFile)?.items.some(
      (entry) => entry.key === promoted.key && entry.filing.mirrors.length > 0,
    )
  ) {
    if (Date.now() > deadline)
      throw new Error("the preferred item's export did not arrive");
    await Bun.sleep(50);
  }
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-rebuild-away-"));
  renameSync(
    join(root, `${promoted.key}.pdf`),
    join(away, `${promoted.key}.pdf`),
  );
  const rebuild = RebuildOutcomeSchema.parse(
    await (await request("POST", `/api/items/${promoted.key}/rebuild`)).json(),
  );
  expect(rebuild.status).toBe("restored");
  expect((await item("rebuild-original")).sourceLineage).toEqual(
    promoted.sourceLineage,
  );
  expect((await item(promoted.key)).sourceLineage).toEqual(
    promoted.sourceLineage,
  );
}, 60_000);

test("deleting a preferred item removes its retained promotion record", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, item } = await bucket(null, localArxiv);
  await capture(
    lectureNotes,
    "delete-original",
    at("/notes/delete-original.pdf"),
  );
  const candidate = await discoveredCandidate(root, "delete-original", request);
  const promoted = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/delete-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  const response = await request("DELETE", `/api/items/${promoted.key}`);
  expect(response.status).toBe(200);
  expect((await item("delete-original")).sourceLineage).toBeUndefined();
  const prefix = `.promotion-${Buffer.from(promoted.key).toString("hex")}-`;
  expect(readdirSync(root).filter((name) => name.startsWith(prefix))).toEqual(
    [],
  );
});

test("forgetting a missing preferred item removes its retained promotion record", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const exportFile = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-promotion-export-")),
    "index.json",
  );
  const { root, request, capture, item } = await bucket(exportFile, localArxiv);
  await capture(
    lectureNotes,
    "forget-original",
    at("/notes/forget-original.pdf"),
  );
  const candidate = await discoveredCandidate(root, "forget-original", request);
  const promoted = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/forget-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  const deadline = Date.now() + 10_000;
  while (
    !readIndexExport(exportFile)?.items.some(
      (entry) => entry.key === promoted.key,
    )
  ) {
    if (Date.now() > deadline)
      throw new Error("the preferred item's export did not arrive");
    await Bun.sleep(50);
  }
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-forget-away-"));
  renameSync(
    join(root, `${promoted.key}.pdf`),
    join(away, `${promoted.key}.pdf`),
  );
  expect((await request("DELETE", `/api/missing/${promoted.key}`)).status).toBe(
    200,
  );
  expect((await item("forget-original")).sourceLineage).toBeUndefined();
  const prefix = `.promotion-${Buffer.from(promoted.key).toString("hex")}-`;
  expect(readdirSync(root).filter((name) => name.startsWith(prefix))).toEqual(
    [],
  );
});

test("reusing a deleted original key does not link the new PDF to the old promotion", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, item } = await bucket(null, localArxiv);
  await capture(lectureNotes, "reused-original", at("/notes/old.pdf"));
  const candidate = await discoveredCandidate(root, "reused-original", request);
  const preferred = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/reused-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  expect((await request("DELETE", "/api/items/reused-original")).status).toBe(
    200,
  );
  await capture(outlinedNotes, "reused-original", at("/notes/new.pdf"));
  expect((await item("reused-original")).sourceLineage).toBeUndefined();
  expect((await item(preferred.key)).sourceLineage).toEqual(
    preferred.sourceLineage,
  );
});

test("a preferred PDF with inconsistent lineage is reported without hiding other papers", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(null, localArxiv);
  await capture(lectureNotes, "readable-original", at("/notes/readable.pdf"));
  const candidate = await discoveredCandidate(
    root,
    "readable-original",
    request,
  );
  const promoted = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/readable-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  renameSync(join(root, `${promoted.key}.pdf`), join(root, "wrong-key.pdf"));
  const result = await library();
  expect(result.items.map((item) => item.id)).toEqual(["readable-original"]);
  expect(result.unreadable).toEqual([
    { file: "wrong-key.pdf", message: "inconsistent embedded source lineage" },
  ]);
});

test("a damaged promotion recovery record does not hide other papers", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(null, localArxiv);
  await capture(
    lectureNotes,
    "damaged-anchor-original",
    at("/notes/damaged.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "damaged-anchor-original",
    request,
  );
  const promoted = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/damaged-anchor-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  const prefix = `.promotion-${Buffer.from(promoted.key).toString("hex")}-`;
  const directory = readdirSync(root).find((name) => name.startsWith(prefix));
  if (directory === undefined)
    throw new Error("promotion record was not created");
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-damaged-anchor-"));
  renameSync(
    join(root, `${promoted.key}.pdf`),
    join(away, `${promoted.key}.pdf`),
  );
  renameSync(join(root, directory, "source.pdf"), join(away, "anchor.pdf"));
  writeFileSync(join(root, directory, "source.pdf"), "not a PDF");
  const result = await library();
  expect(result.items.map((item) => item.id)).toEqual([
    "damaged-anchor-original",
  ]);
  expect(
    result.unreadable.some(
      (entry) => entry.file === join(root, directory, "source.pdf"),
    ),
  ).toBe(true);
});

test("a failed preferred-source fetch leaves the original item usable", async () => {
  served.set("/notes/promotion-failure.pdf", lectureNotes);
  served.delete("/pdf/1234.5678v1");
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, item, library } = await bucket(
    null,
    localArxiv,
  );
  await capture(
    lectureNotes,
    "original-failure",
    at("/notes/promotion-failure.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "original-failure",
    request,
  );
  const response = await request(
    "POST",
    "/api/items/original-failure/arxiv/promote",
    candidate,
  );

  expect(response.status).toBe(422);
  expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe(
    "no_pdf_at_url",
  );
  expect((await library()).items).toHaveLength(1);
  expect((await item("original-failure")).provenance.pdf_url).toBe(
    at("/notes/promotion-failure.pdf"),
  );
});

test("repeating promotion of a missing preferred item does not create a duplicate", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, item, library } = await bucket(
    null,
    localArxiv,
  );
  await capture(
    lectureNotes,
    "missing-preferred",
    at("/notes/missing-preferred.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "missing-preferred",
    request,
  );
  const first = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/missing-preferred/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  const originalLineage = (await item("missing-preferred")).sourceLineage;
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-preferred-away-"));
  renameSync(join(root, `${first.key}.pdf`), join(away, `${first.key}.pdf`));

  const response = await request(
    "POST",
    "/api/items/missing-preferred/arxiv/promote",
    candidate,
  );
  expect(response.status).toBe(200);
  expect(
    ArxivPromotionResponseSchema.parse(await response.json()),
  ).toMatchObject({
    key: first.key,
    existing: true,
    missing: true,
    sourceLineage: originalLineage,
  });
  expect((await item("missing-preferred")).sourceLineage).toEqual(
    originalLineage,
  );
  expect((await library()).items.map((entry) => entry.id)).toEqual([
    "missing-preferred",
  ]);
});

test("promotion refuses a PDF redirect to a different origin", async () => {
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(null, localArxiv);
  await capture(
    lectureNotes,
    "redirect-original",
    at("/notes/redirect-original.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "redirect-original",
    request,
  );
  pdfRedirect = at("/notes/redirect-target.pdf").replace(
    "127.0.0.1",
    "localhost",
  );
  try {
    const response = await request(
      "POST",
      "/api/items/redirect-original/arxiv/promote",
      candidate,
    );
    expect(response.status).toBe(422);
    expect((await library()).items.map((item) => item.id)).toEqual([
      "redirect-original",
    ]);
  } finally {
    pdfRedirect = undefined;
  }
});

test("filing read failure prevents publication of a preferred item", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(null, localArxiv);
  await capture(lectureNotes, "rollback", at("/notes/rollback.pdf"));
  const candidate = await discoveredCandidate(root, "rollback", request);
  const filing = join(root, "organization.json");
  const away = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-filing-away-")),
    "organization.json",
  );
  const present = existsSync(filing);
  if (present) renameSync(filing, away);
  mkdirSync(filing);
  try {
    const response = await request(
      "POST",
      "/api/items/rollback/arxiv/promote",
      candidate,
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
  } finally {
    rmdirSync(filing);
    if (present) renameSync(away, filing);
  }
  expect((await library()).items.map((item) => item.id)).toEqual(["rollback"]);
});

test("promotion preserves unrelated sidecars at the candidate key", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture } = await bucket(null, localArxiv);
  await capture(
    lectureNotes,
    "sidecar-original",
    at("/notes/sidecar-original.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "sidecar-original",
    request,
  );
  const markdown = join(root, "1234.5678v1.md");
  const extraction = join(root, "1234.5678v1.extraction");
  writeFileSync(markdown, "preserve this markdown");
  mkdirSync(extraction);
  writeFileSync(join(extraction, "artifact"), "preserve this artifact");
  const response = await request(
    "POST",
    "/api/items/sidecar-original/arxiv/promote",
    candidate,
  );
  expect(response.status).toBe(200);
  expect(
    ArxivPromotionResponseSchema.parse(await response.json()).key,
  ).not.toBe("1234.5678v1");
  expect(readFileSync(markdown, "utf8")).toBe("preserve this markdown");
  expect(readFileSync(join(extraction, "artifact"), "utf8")).toBe(
    "preserve this artifact",
  );
});

test("promotion refuses a key whose sidecar appears before publication", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const gate = join(mkdtempSync(join(tmpdir(), "pdf-bucket-gate-")), "before");
  const { root, request, capture, library } = await bucket(
    null,
    localArxiv,
    EXTRACTIONS_MANIFEST,
    { PDF_BUCKET_TEST_PROMOTION_BEFORE: gate },
  );
  await capture(
    lectureNotes,
    "concurrent-sidecar",
    at("/notes/concurrent-sidecar.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "concurrent-sidecar",
    request,
  );
  const promotion = request(
    "POST",
    "/api/items/concurrent-sidecar/arxiv/promote",
    candidate,
  );
  await waitForFile(`${gate}.ready`);
  const sidecar = join(root, "1234.5678v1.md");
  writeFileSync(sidecar, "new sidecar");
  writeFileSync(`${gate}.release`, "release");
  expect((await promotion).status).toBeGreaterThanOrEqual(500);
  expect(readFileSync(sidecar, "utf8")).toBe("new sidecar");
  expect((await library()).items.map((item) => item.id)).toEqual([
    "concurrent-sidecar",
  ]);
});

test("promotion does not overwrite or remove a PDF placed by another writer", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const gate = join(mkdtempSync(join(tmpdir(), "pdf-bucket-gate-")), "before");
  const { root, request, capture } = await bucket(
    null,
    localArxiv,
    EXTRACTIONS_MANIFEST,
    { PDF_BUCKET_TEST_PROMOTION_BEFORE: gate },
  );
  await capture(
    lectureNotes,
    "replacement-original",
    at("/notes/replacement-original.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "replacement-original",
    request,
  );
  const replacement = readFileSync(join(root, "replacement-original.pdf"));
  const promotion = request(
    "POST",
    "/api/items/replacement-original/arxiv/promote",
    candidate,
  );
  await waitForFile(`${gate}.ready`);
  const target = join(root, "1234.5678v1.pdf");
  writeFileSync(target, replacement);
  writeFileSync(`${gate}.release`, "release");
  expect((await promotion).status).toBeGreaterThanOrEqual(500);
  expect(readFileSync(target)).toEqual(replacement);
});

test("library reads during promotion see only complete representations", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const gate = join(mkdtempSync(join(tmpdir(), "pdf-bucket-gate-")), "before");
  const { root, request, capture, library } = await bucket(
    null,
    localArxiv,
    EXTRACTIONS_MANIFEST,
    { PDF_BUCKET_TEST_PROMOTION_BEFORE: gate },
  );
  await capture(
    lectureNotes,
    "concurrent-reader",
    at("/notes/concurrent-reader.pdf"),
  );
  const candidate = await discoveredCandidate(
    root,
    "concurrent-reader",
    request,
  );
  const promotion = request(
    "POST",
    "/api/items/concurrent-reader/arxiv/promote",
    candidate,
  );
  await waitForFile(`${gate}.ready`);
  const during = await library();
  expect(during.items.map((item) => item.id)).toEqual(["concurrent-reader"]);
  expect(during.items[0]?.sourceLineage).toBeUndefined();
  writeFileSync(`${gate}.release`, "release");
  const promoted = ArxivPromotionResponseSchema.parse(
    await (await promotion).json(),
  );
  const after = await library();
  expect(after.items).toHaveLength(2);
  expect(
    after.items.every(
      (item) =>
        JSON.stringify(item.sourceLineage) ===
        JSON.stringify(promoted.sourceLineage),
    ),
  ).toBe(true);
});

test.each(["BEFORE", "AFTER"] as const)(
  "promotion interrupted %s publication recovers consistently",
  async (phase) => {
    served.set("/pdf/1234.5678v1", problemSet);
    const config = loadAppConfig(CONFIG_PATH);
    const localArxiv = {
      ...config,
      arxiv: {
        api_url: at("/api/query"),
        abs_url: at("/abs/"),
        pdf_url: at("/pdf/"),
        e_print_url: at("/e-print/"),
      },
    };
    const gate = join(
      mkdtempSync(join(tmpdir(), "pdf-bucket-gate-")),
      phase.toLowerCase(),
    );
    const { root, app, request, capture } = await bucket(
      null,
      localArxiv,
      EXTRACTIONS_MANIFEST,
      { [`PDF_BUCKET_TEST_PROMOTION_${phase}`]: gate },
    );
    await capture(lectureNotes, "interrupted", at("/notes/interrupted.pdf"));
    const candidate = await discoveredCandidate(root, "interrupted", request);
    const promotion = request(
      "POST",
      "/api/items/interrupted/arxiv/promote",
      candidate,
    ).catch(() => undefined);
    await waitForFile(`${gate}.ready`);
    await app.stop();
    await promotion;
    const restarted = await serveBucket({
      root,
      zoteroUrl: closedPortUrl(),
      extractionsManifest: EXTRACTIONS_MANIFEST,
      config: localArxiv,
    });
    try {
      const library = LibraryPayloadSchema.parse(
        await (await restarted.request("/api/library")).json(),
      );
      const original = library.items.find((item) => item.id === "interrupted");
      expect(original).toBeDefined();
      const promoted = library.items.filter(
        (item) => item.id !== "interrupted",
      );
      expect(promoted.length).toBe(phase === "BEFORE" ? 0 : 1);
      if (phase === "AFTER") {
        expect(original?.sourceLineage).toBeDefined();
        expect(original?.sourceLineage?.preferredKey).toBe(promoted[0]?.id);
        expect(promoted[0]?.sourceLineage).toEqual(original?.sourceLineage);
      }
    } finally {
      await restarted.stop();
    }
  },
  60_000,
);

test.each(["CREATED", "PENDING", "BEFORE"] as const)(
  "an interrupted %s promotion cleans only its pending files",
  async (phase) => {
    served.set("/pdf/1234.5678v1", problemSet);
    const config = loadAppConfig(CONFIG_PATH);
    const localArxiv = {
      ...config,
      arxiv: {
        api_url: at("/api/query"),
        abs_url: at("/abs/"),
        pdf_url: at("/pdf/"),
        e_print_url: at("/e-print/"),
      },
    };
    const gate = join(
      mkdtempSync(join(tmpdir(), "pdf-bucket-gate-")),
      phase.toLowerCase(),
    );
    const { root, app, request, capture } = await bucket(
      null,
      localArxiv,
      EXTRACTIONS_MANIFEST,
      { [`PDF_BUCKET_TEST_PROMOTION_${phase}`]: gate },
    );
    await capture(
      lectureNotes,
      "cleanup-original",
      at("/notes/cleanup-original.pdf"),
    );
    const candidate = await discoveredCandidate(
      root,
      "cleanup-original",
      request,
    );
    const pending = request(
      "POST",
      "/api/items/cleanup-original/arxiv/promote",
      candidate,
    ).catch(() => undefined);
    await waitForFile(`${gate}.ready`);
    await app.stop();
    await pending;
    const prefix = `.promotion-${Buffer.from("1234.5678v1").toString("hex")}-`;
    expect(
      readdirSync(root).filter((name) => name.startsWith(prefix)),
    ).toHaveLength(1);
    const unrelated = join(
      root,
      `.promotion-${Buffer.from("unrelated").toString("hex")}-00000000-0000-4000-8000-000000000001`,
    );
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "pending.pdf"), "user data");
    const restarted = await serveBucket({
      root,
      zoteroUrl: closedPortUrl(),
      extractionsManifest: EXTRACTIONS_MANIFEST,
      config: localArxiv,
    });
    try {
      const deadline = Date.now() + 10_000;
      while (readdirSync(root).some((name) => name.startsWith(prefix))) {
        if (Date.now() > deadline)
          throw new Error("the interrupted promotion was not cleaned");
        await Bun.sleep(50);
      }
      const library = LibraryPayloadSchema.parse(
        await (await restarted.request("/api/library")).json(),
      );
      expect(library.items.map((item) => item.id)).toEqual([
        "cleanup-original",
      ]);
      expect(readFileSync(join(unrelated, "pending.pdf"), "utf8")).toBe(
        "user data",
      );
    } finally {
      await restarted.stop();
    }
  },
  60_000,
);

test("a preferred PDF lost before its first export remains rebuildable after restart", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    rebuild: { ...config.rebuild, download_timeout_seconds: 1 },
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const exportFile = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-promotion-export-")),
    "index.json",
  );
  const gate = join(mkdtempSync(join(tmpdir(), "pdf-bucket-gate-")), "after");
  const { root, app, request, capture } = await bucket(
    exportFile,
    localArxiv,
    EXTRACTIONS_MANIFEST,
    { PDF_BUCKET_TEST_PROMOTION_AFTER: gate },
  );
  await capture(lectureNotes, "early-loss", at("/notes/early-loss.pdf"));
  const candidate = await discoveredCandidate(root, "early-loss", request);
  const pending = request(
    "POST",
    "/api/items/early-loss/arxiv/promote",
    candidate,
  ).catch(() => undefined);
  await waitForFile(`${gate}.ready`);
  await app.stop();
  await pending;
  const preferred = "1234.5678v1";
  expect(
    readIndexExport(exportFile)?.items.some((entry) => entry.key === preferred),
  ).toBe(false);
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-early-loss-"));
  renameSync(join(root, `${preferred}.pdf`), join(away, `${preferred}.pdf`));
  const restarted = await serveBucket({
    root,
    indexExport: exportFile,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    config: localArxiv,
  });
  try {
    const deadline = Date.now() + 10_000;
    while (
      !readIndexExport(exportFile)?.items.some(
        (entry) => entry.key === preferred,
      )
    ) {
      if (Date.now() > deadline)
        throw new Error("the missing promotion was not exported");
      await Bun.sleep(50);
    }
    const exported = readIndexExport(exportFile);
    const entry = exported?.items.find((item) => item.key === preferred);
    if (exported === undefined || entry === undefined)
      throw new Error("the missing promotion has no recovery record");
    entry.filing.mirrors.push({
      url: at("/pdf/1234.5678v1"),
      check: { status: "unchecked" },
    });
    writeFileSync(exportFile, JSON.stringify(exported));
    const response = await restarted.request(
      `/api/items/${preferred}/rebuild`,
      { method: "POST" },
    );
    expect(RebuildOutcomeSchema.parse(await response.json()).status).toBe(
      "restored",
    );
    const library = LibraryPayloadSchema.parse(
      await (await restarted.request("/api/library")).json(),
    );
    expect(
      library.items.find((item) => item.id === "early-loss")?.sourceLineage
        ?.preferredKey,
    ).toBe(preferred);
    expect(
      library.items.find((item) => item.id === preferred)?.sourceLineage
        ?.originalKey,
    ).toBe("early-loss");
  } finally {
    await restarted.stop();
  }
}, 60_000);

test("a missing promotion reserves its key even before the export can record it", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const exportDir = mkdtempSync(join(tmpdir(), "pdf-bucket-reserved-export-"));
  const exportFile = join(exportDir, "index.json");
  const { root, app, request, capture } = await bucket(exportFile, localArxiv);
  await capture(lectureNotes, "reserved-original", at("/notes/reserved.pdf"));
  const candidate = await discoveredCandidate(
    root,
    "reserved-original",
    request,
  );
  const promoted = ArxivPromotionResponseSchema.parse(
    await (
      await request(
        "POST",
        "/api/items/reserved-original/arxiv/promote",
        candidate,
      )
    ).json(),
  );
  const deadline = Date.now() + 10_000;
  while (
    !readIndexExport(exportFile)?.items.some(
      (entry) => entry.key === promoted.key,
    )
  ) {
    if (Date.now() > deadline)
      throw new Error("the promotion was not exported");
    await Bun.sleep(50);
  }
  await app.stop();
  const exported = readIndexExport(exportFile);
  if (exported === null) throw new Error("the export is missing");
  exported.items = exported.items.filter((entry) => entry.key !== promoted.key);
  writeFileSync(exportFile, JSON.stringify(exported));
  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-reserved-away-"));
  renameSync(join(root, `${promoted.key}.pdf`), join(away, "preferred.pdf"));
  chmodSync(exportDir, 0o555);
  const restarted = await serveBucket({
    root,
    indexExport: exportFile,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    config: localArxiv,
  });
  try {
    const form = new FormData();
    form.set(
      "pdf",
      new File([outlinedNotes], `${promoted.key}.pdf`, {
        type: "application/pdf",
      }),
    );
    form.set("pdf_url", at("/notes/other.pdf"));
    form.set("title_hint", "Another paper");
    const response = CaptureResponseSchema.parse(
      await (
        await restarted.request("/capture-bytes", {
          method: "POST",
          body: form,
        })
      ).json(),
    );
    expect(response.key).not.toBe(promoted.key);
    expect(
      readIndexExport(exportFile)?.items.some(
        (entry) => entry.key === promoted.key,
      ),
    ).toBe(false);
  } finally {
    await restarted.stop();
    chmodSync(exportDir, 0o700);
  }
}, 60_000);

test("metadata recording failure rolls back a newly captured preferred PDF", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(null, localArxiv);
  await capture(
    lectureNotes,
    "metadata-rollback",
    at("/notes/metadata-rollback.pdf"),
  );
  await recordMetadata(root, "metadata-rollback", "resolver", {
    title: "Promotion Notes",
    authors: [],
    year: 2024,
  });
  atomFeed = `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/1234.5678v1</id><title>Promotion Notes</title><author><name>Bad\u0000author</name></author></entry></feed>`;
  try {
    const search = ArxivSearchResponseSchema.parse(
      await (
        await request("POST", "/api/items/metadata-rollback/arxiv")
      ).json(),
    );
    const candidate = search.matches[0];
    if (candidate === undefined)
      throw new Error("the fixture candidate did not match");
    const response = await request(
      "POST",
      "/api/items/metadata-rollback/arxiv/promote",
      candidate,
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
  } finally {
    atomFeed = undefined;
  }
  expect((await library()).items.map((item) => item.id)).toEqual([
    "metadata-rollback",
  ]);
});

test("lineage persistence failure never publishes a preferred PDF", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, library } = await bucket(
    null,
    localArxiv,
    EXTRACTIONS_MANIFEST,
    {
      PDF_BUCKET_TEST_LINEAGE_SYNC_FAILURE: "1",
    },
  );
  await capture(
    lectureNotes,
    "lineage-failure",
    at("/notes/lineage-failure.pdf"),
  );
  const candidate = await discoveredCandidate(root, "lineage-failure", request);
  const published: string[] = [];
  const watcher = watch(root, (_event, filename) => {
    if (
      filename?.endsWith(".pdf") &&
      !filename.startsWith(".") &&
      filename !== "lineage-failure.pdf"
    )
      published.push(filename);
  });
  try {
    const response = await request(
      "POST",
      "/api/items/lineage-failure/arxiv/promote",
      candidate,
    );
    expect(response.status).toBe(500);
    expect(ApiErrorSchema.parse(await response.json()).error.message).toContain(
      "lineage sync failure",
    );
    await Bun.sleep(100);
    expect(published).toEqual([]);
    expect((await library()).items.map((item) => item.id)).toEqual([
      "lineage-failure",
    ]);
  } finally {
    watcher.close();
  }
});

test("a metadata failure never publishes the preferred PDF", async () => {
  served.set("/pdf/1234.5678v1", problemSet);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture } = await bucket(null, localArxiv);
  await capture(
    lectureNotes,
    "metadata-unpublished",
    at("/notes/metadata-unpublished.pdf"),
  );
  await recordMetadata(root, "metadata-unpublished", "resolver", {
    title: "Promotion Notes",
    authors: [],
    year: 2024,
  });
  atomFeed = `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/1234.5678v1</id><title>Promotion Notes</title><author><name>Bad\u0000author</name></author></entry></feed>`;
  const published: string[] = [];
  const watcher = watch(root, (_event, filename) => {
    if (filename?.endsWith(".pdf") && filename !== "metadata-unpublished.pdf")
      published.push(filename);
  });
  try {
    const search = ArxivSearchResponseSchema.parse(
      await (
        await request("POST", "/api/items/metadata-unpublished/arxiv")
      ).json(),
    );
    const candidate = search.matches[0];
    if (candidate === undefined)
      throw new Error("the fixture candidate did not match");
    const response = await request(
      "POST",
      "/api/items/metadata-unpublished/arxiv/promote",
      candidate,
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    await Bun.sleep(100);
    expect(published).toEqual([]);
  } finally {
    watcher.close();
    atomFeed = undefined;
  }
});

test("promotion preserves a distinct arXiv item even when its original bytes match", async () => {
  served.set("/pdf/1234.5678v1", lectureNotes);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture, item, library } = await bucket(
    null,
    localArxiv,
  );
  await capture(lectureNotes, "same-bytes", at("/notes/same-bytes.pdf"));
  const original = (await item("same-bytes")).provenance;
  const candidate = await discoveredCandidate(root, "same-bytes", request);
  const response = await request(
    "POST",
    "/api/items/same-bytes/arxiv/promote",
    candidate,
  );
  expect(response.status).toBe(200);
  const promoted = ArxivPromotionResponseSchema.parse(await response.json());
  expect(promoted.key).not.toBe("same-bytes");
  expect((await item("same-bytes")).provenance).toEqual(original);
  expect((await item(promoted.key)).provenance.pdf_url).toBe(
    "https://arxiv.org/pdf/1234.5678v1",
  );
  expect((await library()).items).toHaveLength(2);
});

test("a promoted item is eligible for version-matched arXiv source extraction", async () => {
  const source = gzipSync(
    Buffer.from(
      "\\documentclass{article}\\begin{document}Promoted source.\\end{document}",
    ),
  );
  served.set("/pdf/1234.5678v1", problemSet);
  served.set("/e-print/1234.5678v1", new Uint8Array(source));
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const manifest = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-promotion-manifest-")),
    "extractions.json",
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      plugins: [
        {
          id: "arxiv-source",
          name: "arXiv LaTeX source",
          source_kind: "arxiv_latex",
          authoritative: true,
          command: [
            "pdfbucket-arxiv-source",
            "$pdf",
            "$output",
            publisher.url.origin,
          ],
          accepted_inputs: [
            {
              kind: "pdf",
              id: "pdf",
              label: "arXiv PDF",
              limits: [{ kind: "source", value: "arxiv" }],
            },
          ],
        },
      ],
    }),
  );
  const { root, request, capture, item } = await bucket(
    null,
    localArxiv,
    manifest,
  );
  await capture(
    lectureNotes,
    "extraction-original",
    at("/notes/extraction-original.pdf"),
  );
  const original = (await item("extraction-original")).provenance;
  const candidate = await discoveredCandidate(
    root,
    "extraction-original",
    request,
  );
  const promotion = await request(
    "POST",
    "/api/items/extraction-original/arxiv/promote",
    candidate,
  );
  expect(promotion.status).toBe(200);
  const promoted = ArxivPromotionResponseSchema.parse(await promotion.json());
  const extraction = await request(
    "POST",
    `/api/items/${promoted.key}/extractions/arxiv-source`,
  );
  expect(extraction.status).toBe(200);
  expect(
    readFileSync(join(root, `${promoted.key}.extraction/source.eprint`)),
  ).toEqual(source);
  expect(
    readFileSync(join(root, `${promoted.key}.extraction/source.tex`), "utf8"),
  ).toContain("Promoted source.");
  expect((await item("extraction-original")).provenance).toEqual(original);
});

test("known arXiv papers rank in the accepted results on the 20-paper corpus", async () => {
  expect(discoveryCorpus.length).toBeGreaterThanOrEqual(20);
  const config = loadAppConfig(CONFIG_PATH);
  const localArxiv = {
    ...config,
    arxiv: {
      api_url: at("/api/query"),
      abs_url: at("/abs/"),
      pdf_url: at("/pdf/"),
      e_print_url: at("/e-print/"),
    },
  };
  const { root, request, capture } = await bucket(null, localArxiv);
  await capture(lectureNotes, "corpus", at("/notes/corpus.pdf"));
  atomFeed = corpusFeed;
  let accepted = 0;
  try {
    for (const entry of discoveryCorpus) {
      await recordMetadata(root, "corpus", "resolver", {
        title: entry.title.toLowerCase(),
        authors: entry.authors,
        year: 2024,
      });
      const response = await request("POST", "/api/items/corpus/arxiv");
      expect(response.status).toBe(200);
      const result = ArxivSearchResponseSchema.parse(await response.json());
      const expected = entry.id.split("/abs/")[1]?.replace(/v\d+$/, "");
      if (result.matches.some((match) => match.id === expected)) accepted++;
    }
  } finally {
    atomFeed = undefined;
  }
  expect(accepted / discoveryCorpus.length).toBeGreaterThanOrEqual(0.95);
}, 120_000);

test("an item the export holds whose PDF is gone needs re-fetching; Rebuild restores it from the PDF URL or a mirror", async () => {
  served.set("/notes/kept-url.pdf", lectureNotes);
  served.set("/mirror/moved.pdf", problemSet);
  const exportFile = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-sources-export-")),
    "index.json",
  );
  const { root, request, capture, library, item } = await bucket(exportFile);
  await capture(lectureNotes, "kept-url", at("/notes/kept-url.pdf"));
  await capture(problemSet, "moved", at("/notes/moved.pdf"));
  await capture(outlinedNotes, "lost", at("/gone/lost.pdf"));
  await recordMetadata(root, "kept-url", "resolver", {
    title: "Integral Lattices",
    authors: ["Maryna Viazovska"],
    year: 2017,
  });
  await request("POST", "/api/items/moved/mirrors", {
    url: at("/mirror/moved.pdf"),
  });
  // The export is written after each change; wait for the one that holds the mirror.
  let exported = readIndexExport(exportFile);
  while (
    exported?.items.find((entry) => entry.key === "moved")?.filing.mirrors
      .length !== 1
  ) {
    await Bun.sleep(50);
    exported = readIndexExport(exportFile);
  }

  const away = mkdtempSync(join(tmpdir(), "pdf-bucket-sources-away-"));
  for (const key of ["kept-url", "moved", "lost"]) {
    renameSync(join(root, `${key}.pdf`), join(away, `${key}.pdf`));
  }
  const missing = (await library()).missing;
  expect(missing.map((entry) => [entry.key, entry.title]).sort()).toEqual([
    ["kept-url", "Integral Lattices"],
    ["lost", "Notes lost"],
    ["moved", "Notes moved"],
  ]);

  const rebuild = async (key: string) =>
    RebuildOutcomeSchema.parse(
      await (await request("POST", `/api/items/${key}/rebuild`)).json(),
    );
  const rebuildOutcomes = Object.fromEntries(
    await Promise.all(
      recoveryCases.map(async ({ key }) => [key, await rebuild(key)] as const),
    ),
  );
  const recoverable = recoveryCases.filter((fixture) => fixture.recoverable);
  const restoredCases = recoverable.filter(
    (fixture) => rebuildOutcomes[fixture.key].status === "restored",
  );
  expect(restoredCases.length / recoverable.length).toBeGreaterThanOrEqual(
    0.95,
  );

  expect(rebuildOutcomes["kept-url"]).toMatchObject({
    status: "restored",
    from: at("/notes/kept-url.pdf"),
    metadata: { status: "recorded" },
  });
  expect(rebuildOutcomes["moved"]).toMatchObject({
    status: "restored",
    from: at("/mirror/moved.pdf"),
  });
  expect(rebuildOutcomes["lost"]).toMatchObject({ status: "unrestored" });

  const restored = await item("kept-url");
  expect([restored.title, restored.titleSource, restored.authors]).toEqual([
    "Integral Lattices",
    "resolver",
    ["Maryna Viazovska"],
  ]);
  expect((await item("moved")).mirrors.map((mirror) => mirror.url)).toEqual([
    at("/mirror/moved.pdf"),
  ]);
  expect((await library()).missing.map((entry) => entry.key)).toEqual(["lost"]);
});
