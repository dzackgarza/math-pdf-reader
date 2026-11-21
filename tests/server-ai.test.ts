import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSessionRequestSchema } from "../src/contract/ai";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { ApiErrorSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const longNotes = join(import.meta.dir, "fixtures/long-notes.pdf");

async function storedBucket(binary: string) {
  const config = loadAppConfig(CONFIG_PATH);
  config.ai.binary = binary;
  const app = await serveBucket({
    root: mkdtempSync(join(tmpdir(), "pdf-bucket-ai-")),
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

test("a page outside the PDF is refused", async () => {
  const app = await storedBucket("true");

  const response = await app.request("/api/ai/text/long-notes?page=9999");

  expect(response.ok).toBe(false);
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
