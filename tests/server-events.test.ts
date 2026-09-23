import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { CaptureResponseSchema } from "../src/server/contract";

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;

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
  const app = createApp({ root, version: "0.1.0", pdfjsDir: pdfjsDir(config) });
  const subscription = await app.request(`${origin}/api/events`);
  expect(subscription.headers.get("content-type")).toStartWith("text/event-stream");
  const events = openReaderEvents(subscription);

  const capture = async () => {
    const form = new FormData();
    const bytes = readFileSync(join(import.meta.dir, "fixtures/problem-set.pdf"));
    form.set("pdf", new File([bytes], "problem-set.pdf", { type: "application/pdf" }));
    form.set("pdf_url", "https://www.math.example.edu/~author/problem-set.pdf");
    form.set("source_url", "https://www.math.example.edu/~author/teaching.html");
    form.set("title_hint", "Problem set 3");
    const response = await app.request(`${origin}/capture-bytes`, { method: "POST", body: form });
    return CaptureResponseSchema.parse(await response.json());
  };

  const first = await capture();
  expect(first.existing).toBe(false);
  expect(await events.next()).toEqual({ reader_url: `${origin}/read/problem-set` });

  const second = await capture();
  expect(second.existing).toBe(true);
  expect(await events.next()).toEqual({ reader_url: `${origin}/read/problem-set` });

  await events.close();
});
