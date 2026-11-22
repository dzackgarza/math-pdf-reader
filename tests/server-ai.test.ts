import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSessionRequestSchema } from "../src/contract/ai";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { ApiErrorSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const longNotes = join(import.meta.dir, "fixtures/long-notes.pdf");

function extraction(root: string, markdown: string) {
  mkdirSync(join(root, "long-notes.extraction"), { recursive: true });
  writeFileSync(
    join(root, "long-notes.extraction/metadata.json"),
    JSON.stringify({ sourceKind: "document_structure", authoritative: true }),
  );
  writeFileSync(join(root, "long-notes.md"), markdown);
}

async function storedBucket(
  binary: string,
  root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-")),
  aiPort?: number,
) {
  const config = loadAppConfig(CONFIG_PATH);
  config.ai.binary = binary;
  if (aiPort !== undefined) config.ai.port = aiPort;
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    config,
  });
  const form = new FormData();
  form.set("pdf", new File([readFileSync(longNotes)], "long-notes.pdf", { type: "application/pdf" }));
  form.set("pdf_url", "https://www.math.example.edu/~author/long-notes.pdf");
  form.set("title_hint", "Long Notes");
  expect((await app.request("/capture-bytes", { method: "POST", body: form })).status).toBe(200);
  return app;
}

test("the assistant refuses PDFs without a structured extraction", async () => {
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

test("a page outside the PDF is refused as a bad request that names the page count", async () => {
  const app = await storedBucket("true");

  const response = await app.request("/api/ai/text/long-notes?page=9999");

  expect(response.status).toBe(400);
  expect(ApiErrorSchema.parse(await response.json()).error.message).toContain("has ");
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
  expect(ApiErrorSchema.parse(await response.json()).error.kind).toBe("ai_unavailable");
  await app.stop();
});

const view = (app: Awaited<ReturnType<typeof storedBucket>>) =>
  app.request("/api/ai/view/long-notes").then((response) => response.text());
const readPage = (app: Awaited<ReturnType<typeof storedBucket>>, page: number) =>
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
  expect(await response.text()).toContain("page 3 of 200");
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
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const entry = pathname.match(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/(.+)$/);
      if (entry && request.method === "PUT") {
        entries[`${entry[1]}/${entry[2]}`] = ((await request.json()) as { value: unknown }).value;
        return new Response(null, { status: 204 });
      }
      if (pathname === "/api/session" && request.method === "POST") {
        return Response.json({ data: { id: "ses_fake" } });
      }
      if (pathname === "/api/pair") return Response.json({ code: "code" });
      return Response.json({ data: {} });
    },
  });
  return { entries, port: server.port, stop: () => server.stop(true) };
}

test("an assistant session refuses to start without a structured extraction", async () => {
  const assistant = fakeAssistant();
  const app = await storedBucket("true", undefined, assistant.port);
  const response = await app.request("/api/ai/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "long-notes" }),
  });

  expect(response.status).toBe(400);
  expect(ApiErrorSchema.parse(await response.json()).error.message).toContain(
    "no structured extraction",
  );
  await app.stop();
  assistant.stop();
});

test("the assistant's chat is told the reader's page as soon as the reader reports it", async () => {
  const assistant = fakeAssistant();
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  extraction(root, "# Extracted notes\n");
  const app = await storedBucket("true", root, assistant.port);
  expect((await app.request("/api/ai/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "long-notes" }),
  })).status).toBe(200);
  expect(assistant.entries["ses_fake/reader-view"]).toContain("has not recorded a page");

  expect((await readPage(app, 7)).status).toBe(200);

  const entry = String(assistant.entries["ses_fake/reader-view"]);
  expect(entry).toContain("The reader shows page 7 of 200");
  expect(entry).toContain("/api/ai/view/long-notes");
  expect(entry).not.toContain("--- page 7 of ");
  await app.stop();
  assistant.stop();
});
