// Reading sessions at the server boundary: the reader's reports are stored by session id, each
// with the item as it was then, so the timeline outlives the item.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "../src/server/config";
import { EXTRACTIONS_MANIFEST } from "../src/server/extractions";
import { ReadingSessionSchema } from "../src/server/libraryContract";
import { RESOLVERS_MANIFEST } from "../src/server/send";

const config = loadAppConfig(CONFIG_PATH);
const origin = `http://${config.server.host}:${config.server.port}`;
const lectureNotes = join(import.meta.dir, "fixtures/lecture-notes.pdf");

function bucket(root: string) {
  const app = createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl: config.zotero.url,
    extractionsManifest: EXTRACTIONS_MANIFEST,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport: null,
  });
  // A form goes as multipart, anything else as JSON.
  return (method: string, path: string, body?: object) =>
    app.request(`${origin}${path}`, {
      method,
      headers:
        body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" },
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
    });
}

test("a reading session is stored under its id, updated by later reports, and kept after the item leaves", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-sessions-"));
  const request = bucket(root);
  const form = new FormData();
  form.set("pdf", new File([readFileSync(lectureNotes)], "lattices.pdf"));
  form.set("pdf_url", "https://www.math.example.edu/~author/lattices.pdf");
  form.set("source_url", "https://www.math.example.edu/~author/");
  form.set("title_hint", "Lattices and Codes");
  expect((await request("POST", "/capture-bytes", form)).status).toBe(200);

  const report = {
    id: "8a6f0b1e-2c1d-4d5e-9f00-1a2b3c4d5e6f",
    key: "lattices",
    openedAt: "2026-09-25T09:00:00.000Z",
    lastSeenAt: "2026-09-25T09:01:00.000Z",
    pages: [{ page: 1, seconds: 42 }],
  };
  expect((await request("POST", "/api/reading-sessions", report)).status).toBe(200);
  const later = {
    ...report,
    lastSeenAt: "2026-09-25T09:05:00.000Z",
    pages: [
      { page: 1, seconds: 42 },
      { page: 2, seconds: 180 },
    ],
  };
  expect((await request("POST", "/api/reading-sessions", later)).status).toBe(200);

  const sessions = async () =>
    ReadingSessionSchema.array().parse(
      await (await bucket(root)("GET", "/api/reading-sessions")).json(),
    );
  expect(await sessions()).toEqual([
    {
      ...later,
      item: {
        title: "Lattices and Codes",
        authors: [],
        year: null,
        abstract: null,
        sourceUrl: "https://www.math.example.edu/~author/",
      },
    },
  ]);

  // A page under five seconds was scrolled past, not read; an unknown item has no session.
  const glance = {
    ...report,
    id: "9b7f0c2f-3d2e-4e6f-8a11-2b3c4d5e6f70",
    pages: [{ page: 3, seconds: 2 }],
  };
  expect((await request("POST", "/api/reading-sessions", glance)).status).toBe(400);
  const unknown = { ...report, id: "9b7f0c2f-3d2e-4e6f-8a11-2b3c4d5e6f71", key: "missing" };
  expect((await request("POST", "/api/reading-sessions", unknown)).status).toBe(404);

  expect((await request("DELETE", "/api/items/lattices")).status).toBe(200);
  expect((await sessions()).map((session) => session.item.title)).toEqual(["Lattices and Codes"]);
});
