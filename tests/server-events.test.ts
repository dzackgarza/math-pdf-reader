import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureResponseSchema, OpenReaderSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { LibraryPayloadSchema } from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

const config = loadAppConfig(CONFIG_PATH);

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

test("every capture, new or existing, broadcasts its reader URL and stored title to event subscribers", async () => {
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
  const announced = await events.next();
  // The title the library shows for the item, whichever source gave it.
  const library = LibraryPayloadSchema.parse(await (await app.request("/api/library")).json());
  const stored = library.items.find((item) => item.id === "problem-set");
  if (stored === undefined) {
    throw new Error("the library holds no problem-set");
  }
  expect(announced).toEqual({ reader_url: `${app.origin}/read/problem-set`, title: stored.title });

  const second = await capture();
  expect(second.existing).toBe(true);
  expect(await events.next()).toEqual({
    reader_url: `${app.origin}/read/problem-set`,
    title: stored.title,
  });

  await events.close();
});
