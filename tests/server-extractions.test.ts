import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  type AppConfig,
  CONFIG_PATH,
  loadAppConfig,
} from "../src/contract/config";
import {
  ExtractionOutcomeSchema,
  ExtractionPluginsResponseSchema,
} from "../src/contract/extraction";
import { ApiErrorSchema, LibraryPayloadSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";
import { SCRATCH_DATA_HOME } from "./preload";

const config = loadAppConfig(CONFIG_PATH);
const fixture = join(import.meta.dir, "fixtures/ten-page-notes.pdf");
const extractor = join(import.meta.dir, "fixtures/plugins/extractor.sh");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A bucket holding the 10-page fixture under key `lattices`, served over a manifest whose
// plugins are the fixture extractor in the given modes.
async function bucketWithExtractors(
  plugins: { mode: string; maxPages: number; source?: "arxiv" }[],
  appConfig: AppConfig = config,
) {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-extract-"));
  const manifestPath = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-manifest-")),
    "extractions.json",
  );
  const manifest = {
    plugins: plugins.map(({ mode, maxPages, source }) => ({
      id: mode,
      name: `Fixture extractor (${mode})`,
      source_kind: "document_structure",
      authoritative: true,
      command: ["sh", extractor, mode, "$pdf", "$output"],
      accepted_inputs: [
        {
          kind: "pdf",
          id: "pdf",
          label: "PDF",
          limits: [
            { kind: "max_pages", value: maxPages },
            ...(source === undefined
              ? []
              : [{ kind: "source", value: source }]),
          ],
        },
      ],
    })),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: manifestPath,
    config: appConfig,
  });
  const form = new FormData();
  form.set(
    "pdf",
    new File([readFileSync(fixture)], "lattices.pdf", {
      type: "application/pdf",
    }),
  );
  form.set("pdf_url", "https://www.math.example.edu/~author/lattices.pdf");
  form.set("title_hint", "Ten Lectures on Integral Lattices");
  const captured = await app.request("/capture-bytes", {
    method: "POST",
    body: form,
  });
  expect(captured.status).toBe(200);
  return { root, app, manifestPath };
}

test("the shipped extraction plugins are listed with their accepted inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-plugins-"));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });

  const response = await app.request(`/api/plugins/extractions`);

  expect(response.status).toBe(200);
  const { plugins } = ExtractionPluginsResponseSchema.parse(
    await response.json(),
  );
  expect(plugins.map((plugin) => plugin.id)).toEqual([
    "arxiv-source",
    "mineru-flash",
    "mineru-precise",
    "mistral-ocr",
  ]);
  expect(plugins[1]?.accepted_inputs).toEqual([
    {
      kind: "pdf",
      id: "pdf",
      label: "PDF up to 20 pages and 10 MB",
      limits: [
        { kind: "max_pages", value: 20 },
        { kind: "max_bytes", value: 10000000 },
      ],
    },
  ]);
});

test("a successful run answers with the placed artifacts and their hashes", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "record", maxPages: 20 },
  ]);

  const response = await app.request(`/api/items/lattices/extractions/record`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  const outcome = ExtractionOutcomeSchema.parse(await response.json());
  expect(readdirSync(root).sort()).toEqual(["lattices"]);
  const markdown = readFileSync(join(root, "lattices", "lattices.md"));
  const pdf = readFileSync(join(root, "lattices", "lattices.pdf"));
  expect(outcome).toEqual({
    status: "succeeded",
    key: "lattices",
    plugin_id: "record",
    source_kind: "document_structure",
    authoritative: true,
    markdown: {
      path: "lattices.md",
      sha256: sha256(markdown),
      size: markdown.length,
    },
    artifacts: [
      {
        path: "lattices.extraction/source.pdf",
        sha256: sha256(pdf),
        size: pdf.length,
      },
    ],
  });
});

test("a failing plugin answers 502 with its stderr and a rejected PDF answers 422, placing nothing", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "fail", maxPages: 20 },
    { mode: "markdown", maxPages: 5 },
  ]);

  const failed = await app.request(`/api/items/lattices/extractions/fail`, {
    method: "POST",
  });
  expect(failed.status).toBe(502);
  expect(ExtractionOutcomeSchema.parse(await failed.json())).toEqual({
    status: "failed",
    key: "lattices",
    plugin_id: "fail",
    exit_code: 3,
    stderr: "provider quota exhausted for this token\n",
  });

  const rejected = await app.request(
    `/api/items/lattices/extractions/markdown`,
    {
      method: "POST",
    },
  );
  expect(rejected.status).toBe(422);
  expect(ExtractionOutcomeSchema.parse(await rejected.json())).toEqual({
    status: "rejected",
    key: "lattices",
    plugin_id: "markdown",
    violations: [{ limit: { kind: "max_pages", value: 5 }, observed: 10 }],
  });

  expect(readdirSync(root)).toEqual(["lattices"]);
});

test("a plugin restricted to arXiv is rejected before its command runs for another source", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "record", maxPages: 20, source: "arxiv" },
  ]);

  const response = await app.request(`/api/items/lattices/extractions/record`, {
    method: "POST",
  });

  expect(response.status).toBe(422);
  expect(ExtractionOutcomeSchema.parse(await response.json())).toEqual({
    status: "rejected",
    key: "lattices",
    plugin_id: "record",
    violations: [
      {
        limit: { kind: "source", value: "arxiv" },
        observed: "https://www.math.example.edu/~author/lattices.pdf",
      },
    ],
  });
  expect(readdirSync(root)).toEqual(["lattices"]);
});

test("a plugin past its time limit is killed with its children and answers 504 timed_out, placing nothing", async () => {
  const { root, app } = await bucketWithExtractors(
    [{ mode: "hang", maxPages: 20 }],
    {
      ...config,
      plugins: { ...config.plugins, extraction_timeout_seconds: 1 },
    },
  );
  const started = performance.now();

  const response = await app.request(`/api/items/lattices/extractions/hang`, {
    method: "POST",
  });
  const answeredAfter = performance.now() - started;

  expect(response.status).toBe(504);
  expect(ExtractionOutcomeSchema.parse(await response.json())).toEqual({
    status: "timed_out",
    key: "lattices",
    plugin_id: "hang",
    seconds: 1,
  });
  // The answer comes at the limit, not when the plugin's 3 s sleep would have ended.
  expect(answeredAfter).toBeLessThan(3000);
  // Past the end of that sleep: a surviving plugin would have written beside the PDF by now.
  await Bun.sleep(3500 - answeredAfter);
  expect(readdirSync(root)).toEqual(["lattices"]);
}, 15_000);

test("unknown items and unknown plugins are not found", async () => {
  const { app } = await bucketWithExtractors([
    { mode: "markdown", maxPages: 20 },
  ]);

  const missingItem = await app.request(
    `/api/items/missing/extractions/markdown`,
    {
      method: "POST",
    },
  );
  const missingPlugin = await app.request(
    `/api/items/lattices/extractions/mistral`,
    {
      method: "POST",
    },
  );

  expect([missingItem.status, missingPlugin.status]).toEqual([404, 404]);
  // The library API's error shape, which the inspector reports.
  const kinds = await Promise.all(
    [missingItem, missingPlugin].map(
      async (response) =>
        ApiErrorSchema.parse(await response.json()).error.kind,
    ),
  );
  expect(kinds).toEqual(["unknown_item", "unknown_plugin"]);
});

// The one desktop trash entry (freedesktop.org trash specification) named NAME that came from
// below the store ROOT. Publication swaps the new part into place, so the old part reaches the
// trash from the publication's hidden staging directory under its own file name.
function trashed(root: string, name: string): string {
  const trash = join(SCRATCH_DATA_HOME, "Trash");
  const matches = readdirSync(join(trash, "info")).filter((info) => {
    const line = readFileSync(join(trash, "info", info), "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("Path="));
    const path = decodeURI(line?.slice("Path=".length) ?? "");
    return path.startsWith(`${root}/`) && basename(path) === name;
  });
  if (matches.length !== 1) {
    throw new Error(`${matches.length} trash entries named ${name} came from ${root}`);
  }
  return join(trash, "files", matches[0]!.slice(0, -".trashinfo".length));
}

test("a run gets the stored PDF and an empty output directory staged in the root, removed after", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "record", maxPages: 20 },
  ]);

  await app.request(`/api/items/lattices/extractions/record`, {
    method: "POST",
  });

  const [mode, pdf, output] = readFileSync(
    join(root, "lattices", "lattices.md"),
    "utf8",
  )
    .trim()
    .split("\n");
  if (output === undefined) {
    throw new Error("the plugin recorded no output directory");
  }
  expect([mode, pdf]).toEqual([
    "record",
    join(root, "lattices", "lattices.pdf"),
  ]);
  expect(dirname(dirname(output))).toBe(root);
  expect(basename(dirname(output))).toStartWith(".extracting-");
  expect(existsSync(dirname(output))).toBe(false);
});

test("publication failure preserves the complete extraction after restart", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "record", maxPages: 20 },
    { mode: "read-only-output", maxPages: 20 },
  ]);
  const extract = (mode: string) => app.request(`/api/items/lattices/extractions/${mode}`, { method: "POST" });
  expect((await extract("record")).status).toBe(200);
  const document = join(root, "lattices");
  const markdown = join(document, "lattices.md");
  const previous = readFileSync(markdown, "utf8");
  expect((await extract("read-only-output")).status).toBe(500);
  await app.stop();
  const restarted = await serveBucket({ root, zoteroUrl: closedPortUrl(), extractionsManifest: EXTRACTIONS_MANIFEST });
  try {
    expect(readFileSync(markdown, "utf8")).toBe(previous);
    expect(readFileSync(join(document, "lattices.extraction", "source.pdf"))).toEqual(readFileSync(join(document, "lattices.pdf")));
  } finally {
    await restarted.stop();
  }
});

test("the previous extraction stays readable during publication and after interruption", async () => {
  const { app, root, manifestPath } = await bucketWithExtractors([
    { mode: "record", maxPages: 20 },
    { mode: "markdown", maxPages: 20 },
  ]);
  const record = await app.request("/api/items/lattices/extractions/record", { method: "POST" });
  expect(record.status).toBe(200);
  const document = join(root, "lattices");
  const markdown = join(document, "lattices.md");
  const original = readFileSync(markdown, "utf8");
  await app.stop();
  const options = { root, zoteroUrl: closedPortUrl(), extractionsManifest: manifestPath };
  const gate = join(root, ".publication");
  const publishing = await serveBucket({ ...options, env: { PDF_BUCKET_TEST_EXTRACTION_PUBLISH: gate } });
  const request = publishing.request("/api/items/lattices/extractions/markdown", { method: "POST" })
    .catch(() => undefined);
  try {
    const deadline = performance.now() + 15000;
    while (!existsSync(`${gate}.ready`) && performance.now() < deadline) await Bun.sleep(20);
    expect(existsSync(`${gate}.ready`)).toBe(true);
    // Paused between the two swaps: the artifact directory has changed in one step, the
    // Markdown that marks completion still holds the previous complete result.
    expect(existsSync(markdown)).toBe(true);
    expect(readFileSync(markdown, "utf8")).toBe(original);
    expect(readdirSync(join(document, "lattices.extraction"))).toEqual(["metadata.json"]);
  } finally {
    await publishing.stop();
    await request;
  }
  const restarted = await serveBucket(options);
  try {
    expect(readFileSync(markdown, "utf8")).toBe(original);
    expect(readFileSync(join(document, "lattices.extraction", "source.pdf"))).toEqual(
      readFileSync(join(document, "lattices.pdf")),
    );
  } finally {
    await restarted.stop();
  }
}, 30000);

test.each(["keep", "delete", "replace"] as const)("retirement failure followed by %s before restart", async (action) => {
  const { app, root, manifestPath } = await bucketWithExtractors([
    { mode: "record", maxPages: 20 },
    { mode: "markdown", maxPages: 20 },
  ]);
  if (action !== "replace") {
    expect((await app.request("/api/items/lattices/extractions/record", { method: "POST" })).status).toBe(200);
  }
  const document = join(root, "lattices");
  const markdown = join(document, "lattices.md");
  const previous = action === "replace" ? undefined : readFileSync(markdown, "utf8");
  const artifact = join(document, "lattices.extraction", "source.pdf");
  const source = readFileSync(join(document, "lattices.pdf"));
  await app.stop();

  const gate = join(mkdtempSync(join(tmpdir(), "pdf-bucket-retire-gate-")), "publication");
  const options = { root, indexExport: app.indexExport, zoteroUrl: closedPortUrl(), extractionsManifest: manifestPath };
  const publishing = await serveBucket({ ...options, env: { PDF_BUCKET_TEST_EXTRACTION_PUBLISH: gate } });
  const originalMode = statSync(root).mode & 0o777;
  const request = publishing.request("/api/items/lattices/extractions/markdown", { method: "POST" });
  try {
    const deadline = performance.now() + 15000;
    while (!existsSync(`${gate}.ready`) && performance.now() < deadline) await Bun.sleep(20);
    expect(existsSync(`${gate}.ready`)).toBe(true);
    chmodSync(root, 0o500);
    writeFileSync(`${gate}.release`, "go");
    const failed = await request;
    expect(failed.status).toBe(500);
    expect(ApiErrorSchema.parse(await failed.json()).error.message).toContain(
      "previous extraction restored; journal cleanup pending",
    );
    if (action !== "replace") {
      expect(readFileSync(markdown, "utf8")).toBe(previous!);
      expect(readFileSync(artifact)).toEqual(source);
    }
    chmodSync(root, originalMode);
    if (action !== "keep") {
      expect((await publishing.request("/api/items/lattices", { method: "DELETE" })).status).toBe(200);
    }
    if (action === "replace") {
      const form = new FormData();
      const replacement = readFileSync(join(import.meta.dir, "fixtures/lecture-notes.pdf"));
      form.set("pdf", new File([replacement], "lattices.pdf", { type: "application/pdf" }));
      form.set("pdf_url", "https://example.org/replacement.pdf");
      form.set("title_hint", "Replacement");
      const capture = await publishing.request("/capture-bytes", { method: "POST", body: form });
      expect(capture.status).toBe(200);
      expect((await capture.json()).key).toBe("lattices");
      writeFileSync(markdown, "# Replacement");
      mkdirSync(dirname(artifact));
      writeFileSync(artifact, replacement);
    }
  } finally {
    chmodSync(root, originalMode);
    await publishing.stop();
  }

  const restarted = await serveBucket(options);
  try {
    const response = await restarted.request("/api/library");
    expect(response.status).toBe(200);
    const library = LibraryPayloadSchema.parse(await response.json());
    expect(library.items.map(item => item.id)).toEqual(action === "delete" ? [] : ["lattices"]);
    if (action === "keep") {
      expect(readFileSync(markdown, "utf8")).toBe(previous!);
      expect(readFileSync(artifact)).toEqual(source);
    } else if (action === "replace") {
      expect(readFileSync(markdown, "utf8")).toBe("# Replacement");
      expect(readFileSync(artifact)).toEqual(readFileSync(join(import.meta.dir, "fixtures/lecture-notes.pdf")));
    }
  } finally {
    await restarted.stop();
  }
}, 30000);

test("a later run moves the whole previous extraction to the trash; a failed run keeps it", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "record", maxPages: 20 },
    { mode: "markdown", maxPages: 20 },
    { mode: "fail", maxPages: 20 },
  ]);
  await app.request(`/api/items/lattices/extractions/record`, {
    method: "POST",
  });
  const recorded = readFileSync(join(root, "lattices", "lattices.md"), "utf8");

  const later = await app.request(`/api/items/lattices/extractions/markdown`, {
    method: "POST",
  });

  expect(later.status).toBe(200);
  expect(readdirSync(root).sort()).toEqual(["lattices"]);
  expect(readFileSync(join(root, "lattices", "lattices.md"), "utf8")).toBe(
    "# Extracted by the markdown mode\n",
  );
  expect(
    readFileSync(trashed(root, "lattices.md"), "utf8"),
  ).toBe(recorded);
  expect(
    sha256(
      readFileSync(
        join(
          trashed(root, "lattices.extraction"),
          "source.pdf",
        ),
      ),
    ),
  ).toBe(sha256(readFileSync(join(root, "lattices", "lattices.pdf"))));

  const failed = await app.request(`/api/items/lattices/extractions/fail`, {
    method: "POST",
  });
  expect(failed.status).toBe(502);
  expect(readFileSync(join(root, "lattices", "lattices.md"), "utf8")).toBe(
    "# Extracted by the markdown mode\n",
  );
});

test("a plugin that exits 0 without writing extraction.md answers 502 plugin_contract_broken", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "misnamed", maxPages: 20 },
  ]);

  const response = await app.request(
    `/api/items/lattices/extractions/misnamed`,
    {
      method: "POST",
    },
  );

  expect(response.status).toBe(502);
  expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe(
    "plugin_contract_broken",
  );
  expect(readdirSync(root)).toEqual(["lattices"]);
});

test("an extraction finishing after key reuse cannot publish into the replacement paper", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-stale-extraction-"));
  const manifestPath = join(mkdtempSync(join(tmpdir(), "pdf-bucket-manifest-")), "extractions.json");
  writeFileSync(manifestPath, JSON.stringify({ plugins: [{
    id: "await-recapture",
    name: "Wait for recapture",
    source_kind: "document_structure",
    authoritative: true,
    command: ["sh", join(import.meta.dir, "fixtures/plugins/await-recapture.sh"), "$pdf", "$output"],
    accepted_inputs: [{ kind: "pdf", id: "pdf", label: "PDF", limits: [{ kind: "max_pages", value: 20 }] }],
  }] }));
  const app = await serveBucket({ root, zoteroUrl: closedPortUrl(), extractionsManifest: manifestPath });

  async function capture(path: string) {
    const form = new FormData();
    form.set("pdf", new File([readFileSync(path)], "lattices.pdf", { type: "application/pdf" }));
    form.set("pdf_url", `https://example.org/${basename(path)}`);
    form.set("title_hint", "Test paper");
    const response = await app.request("/capture-bytes", { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect((await response.json()).key).toBe("lattices");
  }

  await capture(fixture);
  const running = app.request("/api/items/lattices/extractions/await-recapture", { method: "POST" });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(root, "extraction-started")) && Date.now() < deadline)
    await Bun.sleep(25);
  expect(existsSync(join(root, "extraction-started"))).toBe(true);

  const removed = await app.request("/api/items/lattices", { method: "DELETE" });
  expect(removed.status).toBe(200);
  const replacement = join(import.meta.dir, "fixtures/lecture-notes.pdf");
  await capture(replacement);
  const replacementPdf = join(root, "lattices", "lattices.pdf");
  const storedReplacement = readFileSync(replacementPdf);
  writeFileSync(join(root, "extraction-release"), "release");

  const late = await running;
  expect(late.status).toBe(409);
  expect(ApiErrorSchema.parse(await late.json()).error.kind).toBe("store_failed");
  expect(readFileSync(replacementPdf)).toEqual(storedReplacement);
  expect(existsSync(join(root, "lattices", "lattices.md"))).toBe(false);
  await app.stop();
});

test("a stored extraction is a paper-directory file, not an extraction endpoint", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "markdown", maxPages: 20 },
  ]);
  expect((await app.request("/api/ai/text/lattices")).status).toBe(404);

  const run = await app.request("/api/items/lattices/extractions/markdown", {
    method: "POST",
  });
  expect(run.status).toBe(200);

  expect((await app.request("/api/ai/text/lattices")).status).toBe(404);
  expect(readFileSync(join(root, "lattices", "lattices.md"), "utf8")).toBe(
    "# Extracted by the markdown mode\n",
  );
  await app.stop();
});

test("the server stores the arXiv provider's source archive as authoritative", async () => {
  const source = gzipSync(
    Buffer.from(
      "\\documentclass{article}\\begin{document}Source fixture.\\end{document}",
    ),
  );
  let published: Buffer | null = null;
  const publisher = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/e-print/2301.01234"
        ? published === null
          ? new Response("not found", { status: 404 })
          : new Response(new Uint8Array(published))
        : new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-source-extract-"));
  const manifestPath = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-source-manifest-")),
    "extractions.json",
  );
  writeFileSync(
    manifestPath,
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
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: manifestPath,
  });
  try {
    const form = new FormData();
    form.set(
      "pdf",
      new File([readFileSync(fixture)], "source.pdf", {
        type: "application/pdf",
      }),
    );
    form.set("pdf_url", "https://arxiv.org/pdf/2301.01234");
    form.set("title_hint", "Source fixture");
    expect(
      (await app.request("/capture-bytes", { method: "POST", body: form }))
        .status,
    ).toBe(200);
    for (const invalid of [
      null,
      Buffer.from("%PDF-1.4 no source"),
      Buffer.from("malformed archive"),
    ]) {
      published = invalid;
      const failed = await app.request(
        "/api/items/source/extractions/arxiv-source",
        { method: "POST" },
      );
      expect(failed.status).toBe(502);
      expect(readdirSync(root)).toEqual(["source"]);
      expect((await app.request("/api/ai/text/source")).status).toBe(404);
      expect(existsSync(join(root, "source", "source.md"))).toBe(false);
    }
    published = source;
    const response = await app.request(
      "/api/items/source/extractions/arxiv-source",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const outcome = ExtractionOutcomeSchema.parse(await response.json());
    expect(outcome).toMatchObject({
      status: "succeeded",
      source_kind: "arxiv_latex",
      authoritative: true,
    });
    expect(
      readFileSync(join(root, "source", "source.extraction/source.eprint")),
    ).toEqual(source);
    expect(
      readFileSync(
        join(root, "source", "source.extraction/source.tex"),
        "utf8",
      ),
    ).toContain("Source fixture.");
    expect((await app.request("/api/ai/text/source")).status).toBe(404);
    const library = await (await app.request("/api/library")).json();
    expect(library.items[0].extraction).toMatchObject({
      status: "extracted",
      sourceKind: "arxiv_latex",
      authoritative: true,
    });
  } finally {
    await app.stop();
    publisher.stop(true);
  }
}, 30_000);

test("an arXiv provider without source artifacts cannot create an authoritative result", async () => {
  const { root, app } = await bucketWithExtractors([
    { mode: "markdown", maxPages: 20 },
  ]);
  const manifestPath = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-contract-")),
    "extractions.json",
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: [
        {
          id: "markdown",
          name: "Missing source",
          source_kind: "arxiv_latex",
          authoritative: true,
          command: ["sh", extractor, "markdown", "$pdf", "$output"],
          accepted_inputs: [
            { kind: "pdf", id: "pdf", label: "PDF", limits: [] },
          ],
        },
      ],
    }),
  );
  const checked = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: manifestPath,
  });
  try {
    const response = await checked.request(
      "/api/items/lattices/extractions/markdown",
      { method: "POST" },
    );
    expect(response.status).toBe(502);
    expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe(
      "plugin_contract_broken",
    );
    expect(readdirSync(root)).toEqual(["lattices"]);
  } finally {
    await checked.stop();
    await app.stop();
  }
}, 30_000);

test("the server runs the Mistral OCR provider against a local OCR service", async () => {
  const calls: string[] = [];
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.headers.get("authorization") !== "Bearer fixture-key") {
        return Response.json({ error: "bad credentials" }, { status: 401 });
      }
      if (request.method === "POST" && path === "/v1/files") {
        const body = await request.arrayBuffer();
        return Response.json({
          id: "file-1",
          object: "file",
          bytes: body.byteLength,
          created_at: 0,
          filename: "fixture.pdf",
          purpose: "ocr",
          sample_type: "pretrain",
          source: "upload",
        });
      }
      if (request.method === "GET" && path === "/v1/files/file-1/url") {
        return Response.json({
          url: new URL("/signed/file-1", request.url).href,
        });
      }
      if (request.method === "POST" && path === "/v1/ocr") {
        return Response.json({
          model: "mistral-ocr-latest",
          pages: [
            {
              index: 0,
              markdown: "# OCR fixture\n\nStructured mathematics.",
              images: [],
              dimensions: null,
            },
          ],
          usage_info: { pages_processed: 1 },
        });
      }
      if (request.method === "DELETE" && path === "/v1/files/file-1") {
        return Response.json({ id: "file-1", object: "file", deleted: true });
      }
      return Response.json(
        { error: `unexpected ${request.method} ${path}` },
        { status: 404 },
      );
    },
  });
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ocr-"));
  const manifestPath = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-ocr-manifest-")),
    "extractions.json",
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: [
        {
          id: "mistral-ocr",
          name: "Mistral OCR",
          source_kind: "ocr",
          authoritative: true,
          command: [
            "pdfbucket-mistral-ocr",
            "$pdf",
            "$output",
            service.url.origin,
          ],
          accepted_inputs: [
            { kind: "pdf", id: "pdf", label: "PDF", limits: [] },
          ],
        },
      ],
    }),
  );
  const previous = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = "fixture-key";
  let app: Awaited<ReturnType<typeof serveBucket>>;
  try {
    app = await serveBucket({
      root,
      zoteroUrl: closedPortUrl(),
      extractionsManifest: manifestPath,
    });
  } finally {
    if (previous === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = previous;
  }
  try {
    const form = new FormData();
    form.set(
      "pdf",
      new File([readFileSync(fixture)], "ocr.pdf", { type: "application/pdf" }),
    );
    form.set("pdf_url", "https://example.org/ocr.pdf");
    form.set("title_hint", "OCR fixture");
    expect(
      (await app.request("/capture-bytes", { method: "POST", body: form }))
        .status,
    ).toBe(200);
    const response = await app.request(
      "/api/items/ocr/extractions/mistral-ocr",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(ExtractionOutcomeSchema.parse(await response.json())).toMatchObject({
      status: "succeeded",
      source_kind: "ocr",
      authoritative: true,
    });
    expect(readFileSync(join(root, "ocr", "ocr.md"), "utf8")).toContain(
      "Structured mathematics.",
    );
    expect(calls).toEqual([
      "POST /v1/files",
      "GET /v1/files/file-1/url",
      "POST /v1/ocr",
      "DELETE /v1/files/file-1",
    ]);
  } finally {
    await app.stop();
    service.stop(true);
  }
}, 30_000);
