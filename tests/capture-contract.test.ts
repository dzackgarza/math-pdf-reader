import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureResponseSchema, OpenReaderSchema } from "../src/contract/capture";
import { ApiErrorSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket, subscribeEvents } from "./bucket";
import { captureDownload, captureForm } from "./capture-helpers";

test("capture endpoints and open-reader events share the capture contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-contract-"));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
  });
  const events = await subscribeEvents(app);
  const bytes = readFileSync(join(import.meta.dir, "fixtures/problem-set.pdf"));
  const source = "https://example.test/problem-set.pdf";

  const multipart = await app.request("/capture-bytes", {
    method: "POST",
    body: captureForm(bytes, source, "problem-set.pdf", "Problem set"),
  });
  const first = CaptureResponseSchema.parse(await multipart.json());
  expect(first.existing).toBe(false);
  expect(OpenReaderSchema.parse(await events.next("open-reader", OpenReaderSchema))).toEqual({
    reader_url: first.reader_url,
    title: "Problem set",
  });

  const downloaded = join(mkdtempSync(join(tmpdir(), "pdf-bucket-download-")), "download.pdf");
  copyFileSync(join(import.meta.dir, "fixtures/problem-set.pdf"), downloaded);
  const download = await app.request(
    "/capture-download",
    captureDownload(downloaded, "https://example.test/download.pdf", "download.pdf", "Download"),
  );
  const second = CaptureResponseSchema.parse(await download.json());
  expect(second.existing).toBe(true);

  const importResponse = await app.request("/api/import-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ open_reader: false, url: "not-a-url" }),
  });
  expect(ApiErrorSchema.parse(await importResponse.json()).error.kind).toBe("invalid_request");

  await events.close();
});
