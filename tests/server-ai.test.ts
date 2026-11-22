import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSessionRequestSchema } from "../src/contract/ai";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { ApiErrorSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const longNotes = join(import.meta.dir, "fixtures/long-notes.pdf");

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

test("the PDF's text is served as plain text, whole or one page", async () => {
  const app = await storedBucket("true");

  const whole = await app.request("/api/ai/text/long-notes");
  const first = await app.request("/api/ai/text/long-notes?page=1");

  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-type")).toContain("text/plain");
  const wholeText = await whole.text();
  expect(wholeText).toContain("--- page 1 of ");
  const firstText = await first.text();
  expect(firstText).toContain("--- page 1 of ");
  expect(firstText).not.toContain("--- page 2 of ");
  expect(wholeText.length).toBeGreaterThan(firstText.length);
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
  const app = await storedBucket("false");

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

test("the view names the page the reader shows, with that page's own text", async () => {
  const app = await storedBucket("true");

  expect(await view(app)).toContain("no page is recorded");
  expect((await readPage(app, 3)).status).toBe(200);
  const shown = await view(app);

  expect(shown).toContain("The reader shows page 3 of 200");
  expect(shown).toContain("--- page 3 of ");
  expect(shown).not.toContain("--- page 4 of ");
  expect(shown).not.toContain("In the extraction");
  await app.stop();
});

test("with an extraction the view says where the page lies in it, or that it matches nowhere", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
  const app = await storedBucket("true", root);
  writeFileSync(join(root, "long-notes.md"), "# Notes\n\nA paragraph of an extraction.\n");
  expect((await readPage(app, 3)).status).toBe(200);

  const shown = await view(app);

  expect(shown).toContain("The page's words match nowhere in the extraction");
  expect(shown).toContain("--- page 3 of ");
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

test("the assistant's chat is told the reader's page as soon as the reader reports it", async () => {
  const assistant = fakeAssistant();
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-"));
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
