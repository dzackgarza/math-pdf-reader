import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AiSessionRequestSchema } from "../src/contract/ai";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { ExtractionOutcomeSchema } from "../src/contract/extraction";
import { ApiErrorSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const longNotes = join(import.meta.dir, "fixtures/long-notes.pdf");

function extraction(
  root: string,
  markdown: string,
  sourceKind: "document_structure" | "arxiv_latex" = "document_structure",
) {
  const artifactDirectory = join(root, "long-notes.extraction");
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(
    join(artifactDirectory, "metadata.json"),
    JSON.stringify({ sourceKind, authoritative: true }),
  );
  writeFileSync(join(root, "long-notes.md"), markdown);
  if (sourceKind === "arxiv_latex") {
    writeFileSync(join(artifactDirectory, "source.tex"), "\\section{Notes}\n");
    writeFileSync(
      join(artifactDirectory, "source.eprint"),
      "arXiv source archive\n",
    );
  }
}

async function storedBucket(
  binary: string,
  root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-")),
  aiPort?: number,
  extractionsManifest = EXTRACTIONS_MANIFEST,
) {
  const config = loadAppConfig(CONFIG_PATH);
  config.ai.binary = binary;
  if (aiPort !== undefined) config.ai.port = aiPort;
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest,
    config,
  });
  const form = new FormData();
  form.set(
    "pdf",
    new File([readFileSync(longNotes)], "long-notes.pdf", {
      type: "application/pdf",
    }),
  );
  form.set("pdf_url", "https://www.math.example.edu/~author/long-notes.pdf");
  form.set("title_hint", "Long Notes");
  expect(
    (await app.request("/capture-bytes", { method: "POST", body: form }))
      .status,
  ).toBe(200);
  return app;
}

function fixtureExtractionManifest(): string {
  const directory = mkdtempSync(join(tmpdir(), "pdf-bucket-manifest-"));
  const manifest = join(directory, "extractions.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      plugins: [
        {
          id: "markdown",
          name: "Markdown extraction fixture",
          source_kind: "document_structure",
          authoritative: true,
          command: [
            join(import.meta.dir, "fixtures/plugins/extractor.sh"),
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
  return manifest;
}

test("the structured-text endpoint identifies a missing extraction", async () => {
  const app = await storedBucket("true");

  const response = await app.request("/api/ai/text/long-notes");

  expect(response.status).toBe(400);
  expect(ApiErrorSchema.parse(await response.json()).error.message).toContain(
    "no structured extraction",
  );
  await app.stop();
});

test("the assistant text endpoint serves only the structured extraction", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const app = await storedBucket("true", root);
  extraction(root, "# Extracted notes\n");

  const whole = await app.request("/api/ai/text/long-notes");
  const page = await app.request("/api/ai/text/long-notes?page=1");

  expect(whole.status).toBe(200);
  expect(await whole.text()).toBe("# Extracted notes\n");
  expect(page.status).toBe(400);
  expect(ApiErrorSchema.parse(await page.json()).error.message).toContain(
    "page-specific PDF text is unavailable",
  );
  await app.stop();
});

test("the raw-PDF text endpoint serves exactly one selected non-first page without an extraction", async () => {
  const app = await storedBucket("true");

  const response = await app.request("/api/ai/pdf-text/long-notes?page=2");

  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("--- page 2 of 210 ---");
  expect(text).toContain("Lecture 2");
  expect(text).toContain(
    "The lattice Z2 has determinant 1 and 2 · 2 vectors of norm 1.",
  );
  expect(text.match(/^--- page \d+ of \d+ ---$/gm)).toHaveLength(1);
  expect(text).not.toContain("Lecture 1");
  await app.stop();
});

test("a page outside the raw PDF is refused as a bad request that names the page count", async () => {
  const app = await storedBucket("true");

  const response = await app.request("/api/ai/pdf-text/long-notes?page=9999");

  expect(response.status).toBe(400);
  const error = ApiErrorSchema.parse(await response.json()).error;
  expect(error.kind).toBe("invalid_request");
  expect(error.message).toContain("has 210 pages");
  await app.stop();
});

test("an assistant that cannot start is reported as unavailable, with its own output", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const app = await storedBucket("false", root);
  extraction(root, "# Extracted notes\n");

  const response = await app.request("/api/ai/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(AiSessionRequestSchema.parse({ key: "long-notes" })),
  });

  expect(response.status).toBe(502);
  expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe(
    "ai_unavailable",
  );
  await app.stop();
});

test("the generated assistant permission configuration grants read access to the stored raw PDF", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const app = await storedBucket("false", root);
  const response = await app.request("/api/ai/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "long-notes" }),
  });

  expect(response.status).toBe(502);
  const config = JSON.parse(
    readFileSync(join(dirname(app.indexExport), "ai/reader.json"), "utf8"),
  ) as {
    agents: {
      reader: {
        permissions: Array<{
          action: string;
          resource: string;
          effect: string;
        }>;
      };
    };
  };
  expect(config.agents.reader.permissions).toContainEqual({
    action: "read",
    resource: `${root}/*.pdf`,
    effect: "allow",
  });
  await app.stop();
});

const view = (app: Awaited<ReturnType<typeof storedBucket>>) =>
  app.request("/api/ai/view/long-notes").then((response) => response.text());
const readPage = (
  app: Awaited<ReturnType<typeof storedBucket>>,
  page: number,
) =>
  app.request("/api/items/long-notes/reading", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page, pages: 200 }),
  });

test("the view reports the exact shown page even without structured extraction", async () => {
  const app = await storedBucket("true");

  expect(await view(app)).toContain("no page is recorded");
  expect((await readPage(app, 3)).status).toBe(200);
  const response = await app.request("/api/ai/view/long-notes");

  expect(response.status).toBe(200);
  const shown = await response.text();
  expect(shown).toContain("page 3 of 200");
  expect(shown).toContain("/api/ai/pdf-text/long-notes?page=3");
  await app.stop();
});

test("the view gives a search hint without guessing extraction line ranges", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const app = await storedBucket("true", root);
  extraction(root, "# Notes\n\nA paragraph of an extraction.\n");
  expect((await readPage(app, 3)).status).toBe(200);

  const shown = await view(app);

  expect(shown).toContain("page 3 of 200");
  expect(shown).toContain("/api/ai/text/long-notes");
  expect(shown).toContain("search hint");
  expect(shown).not.toContain("covers about lines");
  expect(shown).not.toContain("--- page 3 of ");
  await app.stop();
});

// A stand-in for the private OpenCode server: it answers what the bucket asks of it and keeps
// the instruction entries it is given. The bucket treats a server that answers as its own.
function fakeAssistant() {
  const entries: Record<string, unknown> = {};
  const workspaces: Record<string, string> = {};
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const entry = pathname.match(
        /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/(.+)$/,
      );
      if (entry && request.method === "PUT") {
        entries[`${entry[1]}/${entry[2]}`] = (
          (await request.json()) as { value: unknown }
        ).value;
        return new Response(null, { status: 204 });
      }
      if (pathname === "/api/session" && request.method === "POST") {
        const body = (await request.json()) as {
          location: { directory: string };
        };
        workspaces.ses_fake = body.location.directory;
        return Response.json({ data: { id: "ses_fake" } });
      }
      if (pathname === "/api/pair") return Response.json({ code: "code" });
      return Response.json({ data: {} });
    },
  });
  return {
    entries,
    workspaces,
    port: server.port,
    stop: () => server.stop(true),
  };
}

test("an extraction placed after a chat opens refreshes the chat's paper-source instructions", async () => {
  const assistant = fakeAssistant();
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const manifest = fixtureExtractionManifest();
  const app = await storedBucket("true", root, assistant.port, manifest);
  expect(
    (
      await app.request("/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "long-notes" }),
      })
    ).status,
  ).toBe(200);
  expect((await readPage(app, 2)).status).toBe(200);
  const workspace = assistant.workspaces.ses_fake;
  expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).not.toContain(
    "/api/ai/text/long-notes",
  );
  expect(assistant.entries["ses_fake/reader-view"]).not.toContain(
    "/api/ai/text/long-notes",
  );

  const extracted = await app.request(
    "/api/items/long-notes/extractions/markdown",
    {
      method: "POST",
    },
  );

  expect(extracted.status).toBe(200);
  expect(ExtractionOutcomeSchema.parse(await extracted.json()).status).toBe(
    "succeeded",
  );
  expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain(
    "/api/ai/text/long-notes",
  );
  expect(assistant.entries["ses_fake/reader-view"]).toContain(
    "/api/ai/text/long-notes",
  );
  await app.stop();
  assistant.stop();
});

test("an extraction without an open chat leaves the assistant dormant", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const aiPort = Number(new URL(closedPortUrl()).port);
  const app = await storedBucket(
    join(root, "assistant-must-not-start"),
    root,
    aiPort,
    fixtureExtractionManifest(),
  );

  const extracted = await app.request(
    "/api/items/long-notes/extractions/markdown",
    { method: "POST" },
  );

  expect(extracted.status).toBe(200);
  expect(ExtractionOutcomeSchema.parse(await extracted.json()).status).toBe(
    "succeeded",
  );
  await app.stop();
});

for (const sourceKind of ["document_structure", "arxiv_latex"] as const) {
  test(`an assistant session with ${sourceKind} extraction names its text endpoint in workspace instructions`, async () => {
    const assistant = fakeAssistant();
    const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
    extraction(root, "# Extracted notes\n", sourceKind);
    const app = await storedBucket("true", root, assistant.port);
    const response = await app.request("/api/ai/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "long-notes" }),
    });

    expect(response.status).toBe(200);
    const instructions = readFileSync(
      join(assistant.workspaces.ses_fake, "AGENTS.md"),
      "utf8",
    );
    expect(instructions).toContain(`GET ${app.origin}/api/ai/text/long-notes`);
    expect(instructions).toContain(
      sourceKind === "arxiv_latex"
        ? join(root, "long-notes.extraction/source.tex")
        : join(root, "long-notes.md"),
    );
    await app.stop();
    assistant.stop();
  });
}

test("an assistant session starts without an extraction and names the stored raw PDF", async () => {
  const assistant = fakeAssistant();
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const app = await storedBucket("true", root, assistant.port);
  const response = await app.request("/api/ai/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "long-notes" }),
  });

  expect(response.status).toBe(200);
  const workspace = assistant.workspaces.ses_fake;
  const instructions = readFileSync(join(workspace, "AGENTS.md"), "utf8");
  expect(instructions).toContain(join(root, "long-notes.pdf"));
  expect(instructions).toContain("/api/ai/pdf-text/long-notes?page=N");
  await app.stop();
  assistant.stop();
});

test("the assistant's chat is told the reader's page as soon as the reader reports it", async () => {
  const assistant = fakeAssistant();
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  extraction(root, "# Extracted notes\n");
  const app = await storedBucket("true", root, assistant.port);
  expect(
    (
      await app.request("/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "long-notes" }),
      })
    ).status,
  ).toBe(200);
  expect(assistant.entries["ses_fake/reader-view"]).toContain(
    "has not recorded a page",
  );

  expect((await readPage(app, 7)).status).toBe(200);

  const entry = String(assistant.entries["ses_fake/reader-view"]);
  expect(entry).toContain("The reader shows page 7 of 200");
  expect(entry).toContain("/api/ai/pdf-text/long-notes?page=7");
  expect(entry).toContain("/api/ai/view/long-notes");
  expect(entry).not.toContain("--- page 7 of ");
  await app.stop();
  assistant.stop();
});
