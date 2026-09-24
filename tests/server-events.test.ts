import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CaptureResponseSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

const config = loadAppConfig(CONFIG_PATH);

const OpenReaderSchema = z.strictObject({ reader_url: z.url() });

// Server-sent events off a response body, one parsed `open-reader` payload per call.
function openReaderEvents(response: Response) {
  if (response.body === null) {
    throw new Error("the event stream response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next() {
      for (;;) {
        const match = /event: open-reader\ndata: (.*)\n\n/.exec(buffered);
        if (match !== null) {
          buffered = buffered.slice(match.index + match[0].length);
          return OpenReaderSchema.parse(JSON.parse(match[1]));
        }
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        buffered += decoder.decode(chunk.value);
      }
    },
    close: () => reader.cancel(),
  };
}

test("every capture, new or existing, broadcasts its reader URL to event subscribers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-events-"));
  const app = await serveBucket({
    root,
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
  });
  const subscription = await app.request(`/api/events`);
  expect(subscription.headers.get("content-type")).toStartWith("text/event-stream");
  const events = openReaderEvents(subscription);

  const capture = async () => {
    const form = new FormData();
    const bytes = readFileSync(join(import.meta.dir, "fixtures/problem-set.pdf"));
    form.set("pdf", new File([bytes], "problem-set.pdf", { type: "application/pdf" }));
    form.set("pdf_url", "https://www.math.example.edu/~author/problem-set.pdf");
    form.set("source_url", "https://www.math.example.edu/~author/teaching.html");
    form.set("title_hint", "Problem set 3");
    const response = await app.request(`/capture-bytes`, { method: "POST", body: form });
    return CaptureResponseSchema.parse(await response.json());
  };

  const first = await capture();
  expect(first.existing).toBe(false);
  expect(await events.next()).toEqual({ reader_url: `${app.origin}/read/problem-set` });

  const second = await capture();
  expect(second.existing).toBe(true);
  expect(await events.next()).toEqual({ reader_url: `${app.origin}/read/problem-set` });

  await events.close();
});
