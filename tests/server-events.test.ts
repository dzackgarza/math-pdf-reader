import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureResponseSchema,
  OpenReaderSchema,
  ZoteroHealthSchema,
} from "../src/contract/capture";
import { LibraryPayloadSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket, subscribeEvents } from "./bucket";

test("every capture, new or existing, broadcasts its reader URL and stored title to event subscribers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-events-"));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  const events = await subscribeEvents(app);
  const openReader = () => events.next("open-reader", OpenReaderSchema);

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
  const announced = await openReader();
  // The title the library shows for the item, whichever source gave it.
  const library = LibraryPayloadSchema.parse(await (await app.request("/api/library")).json());
  const stored = library.items.find((item) => item.id === "problem-set");
  if (stored === undefined) {
    throw new Error("the library holds no problem-set");
  }
  expect(announced).toEqual({ reader_url: `${app.origin}/read/problem-set`, title: stored.title });

  const second = await capture();
  expect(second.existing).toBe(true);
  expect(await openReader()).toEqual({
    reader_url: `${app.origin}/read/problem-set`,
    title: stored.title,
  });

  await events.close();
});

test("the event stream reports Zotero's health: not running while its port is closed, then ready with the write API's version", async () => {
  const zoteroUrl = closedPortUrl();
  const app = await serveBucket({
    root: mkdtempSync(join(tmpdir(), "pdf-bucket-events-")),
    zoteroUrl,
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  const events = await subscribeEvents(app);
  const zotero = () => events.next("zotero", ZoteroHealthSchema);

  let health = await zotero();
  while (health.status === "checking") {
    health = await zotero();
  }
  expect(health).toEqual({
    status: "unavailable",
    message: "Zotero is not running: start Zotero",
  });

  const { hostname, port } = new URL(zoteroUrl);
  const version = readFileSync(join(import.meta.dir, "fixtures/zotero/version.json"), "utf8");
  const started = Bun.serve({
    hostname,
    port: Number(port),
    fetch: (request) =>
      new URL(request.url).pathname === "/version"
        ? new Response(version, { headers: { "Content-Type": "application/json" } })
        : new Response("not the health check", { status: 404 }),
  });
  expect(await zotero()).toEqual({ status: "ready", version: "3.4.0" });

  started.stop(true);
  await events.close();
});
