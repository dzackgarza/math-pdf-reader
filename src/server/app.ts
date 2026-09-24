import { existsSync, statSync } from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { CONFIG_PATH, loadAppConfig, WEB_DIST_DIR } from "./config";
import type { CaptureResponse } from "./contract";
import { BucketEvents } from "./events";
import { registerExtractionRoutes } from "./extractions";
import { findPdfAt, pdfsInFolder } from "./imports";
import { IndexExporter } from "./indexExport";
import { registerLibraryRoutes } from "./library";
import {
  FolderImportRequestSchema,
  type FolderImportResponse,
  ImportUrlRequestSchema,
  type ImportUrlResponse,
} from "./libraryContract";
import { pdfUrlPath, readerPage, readerUrlPath } from "./reader";
import { serverStatus } from "./status";
import { type CaptureUpload, captureBytes, StoreCommandError, storedPdfPath } from "./store";
import { thumbnailRoutes } from "./thumbnails";
import { retrieveMetadata } from "./titles";
import { ZoteroError, ZoteroWriteApi } from "./zotero";

export type AppConfig = {
  root: string;
  version: string;
  pdfjsDir: string;
  // Zotero's local HTTP server, which carries the write API the send action uses.
  zoteroUrl: string;
  // The extraction plugins the inspector lists and runs.
  extractionsManifest: string;
  // The identifier resolvers that give captured items their titles.
  resolversManifest: string;
  // The index export the server rewrites after every change, or null for a bucket whose
  // changes are not exported (tests, evidence runs).
  indexExport: string | null;
};

const CaptureFormSchema = z.strictObject({
  pdf: z.instanceof(File),
  pdf_url: z.url({ protocol: /^https?$/ }),
  source_url: z.url({ protocol: /^https?$/ }),
  title_hint: z.string().min(1),
});

async function isPdf(file: File): Promise<boolean> {
  const magic = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
  return magic === "%PDF-";
}

export function createApp(config: AppConfig): Hono {
  const app = new Hono();
  const events = new BucketEvents();

  app.onError((error, c) => {
    if (error instanceof StoreCommandError) {
      return c.json(
        { error: "store_command_failed", exit_code: error.exitCode, stderr: error.stderr },
        500,
      );
    }
    if (error instanceof ZoteroError) {
      return c.json({ error: { kind: "zotero_failed", message: error.message } }, 502);
    }
    throw error;
  });

  const exporter =
    config.indexExport === null ? null : new IndexExporter(config.root, config.indexExport);
  const library = registerLibraryRoutes(
    app,
    config.root,
    new ZoteroWriteApi(config.zoteroUrl),
    config.resolversManifest,
    exporter,
  );
  exporter?.changed();

  // Stores an upload; a new item takes its title from a resolver when one knows its
  // identifier, and a resolver that fails leaves the title the PDF itself gives.
  const store = async (upload: CaptureUpload) => {
    const result = await captureBytes(config.root, upload);
    if (!result.existing) {
      await retrieveMetadata(config.root, result.item.key, config.resolversManifest);
    }
    library.stored();
    return result;
  };
  const downloads = loadAppConfig(CONFIG_PATH).rebuild;

  app.post("/api/import-url", async (c) => {
    const body = ImportUrlRequestSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: { kind: "invalid_request", message: body.error.message } }, 400);
    }
    const found = await findPdfAt(body.data.url, downloads);
    if ("failure" in found) {
      return c.json({ error: { kind: "no_pdf_at_url", message: found.failure } }, 422);
    }
    const result = await store(found.upload);
    const response: ImportUrlResponse = { key: result.item.key, existing: result.existing };
    return c.json(response);
  });

  app.post("/api/import-folder", async (c) => {
    const body = FolderImportRequestSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: { kind: "invalid_request", message: body.error.message } }, 400);
    }
    const folder = body.data.path;
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      return c.json({ error: { kind: "not_a_folder", message: `${folder} is no folder` } }, 400);
    }
    const response: FolderImportResponse = { stored: [], existing: [] };
    for (const upload of await pdfsInFolder(folder)) {
      const result = await store(upload);
      (result.existing ? response.existing : response.stored).push(result.item.key);
    }
    return c.json(response);
  });

  app.get("/status", async (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(await serverStatus(config.root, origin, config.version));
  });

  app.post("/capture-bytes", async (c) => {
    const form = CaptureFormSchema.safeParse(await c.req.parseBody());
    if (!form.success) {
      return c.json({ error: "invalid_capture_form", issues: form.error.issues }, 400);
    }
    if (!(await isPdf(form.data.pdf))) {
      return c.json({ error: "not_a_pdf" }, 400);
    }
    const result = await store(form.data);
    const response: CaptureResponse = {
      key: result.item.key,
      existing: result.existing,
      stored_sha256: result.stored_sha256,
      reader_url: new URL(readerUrlPath(result.item.key), c.req.url).href,
      pdf_url: new URL(pdfUrlPath(result.item.key), c.req.url).href,
      provenance: result.item.provenance,
    };
    events.publishOpenReader({ reader_url: response.reader_url });
    return c.json(response);
  });

  app.get("/api/events", (c) => events.stream(c));

  app.get("/pdf/:file{.+\\.pdf}", (c) => {
    const path = storedPdfPath(config.root, c.req.param("file").slice(0, -".pdf".length));
    if (path === null) {
      return c.notFound();
    }
    return new Response(Bun.file(path), { headers: { "Content-Type": "application/pdf" } });
  });

  app.get("/read/:key", async (c) => {
    const found = await library.item(c.req.param("key"));
    if (found === null) {
      return c.notFound();
    }
    return c.html(readerPage(found.item, new URL(c.req.url).origin));
  });

  registerExtractionRoutes(app, config.root, config.extractionsManifest);
  thumbnailRoutes(app, config.root);

  app.use(
    "/pdfjs/*",
    serveStatic({
      root: config.pdfjsDir,
      rewriteRequestPath: (path) => path.slice("/pdfjs".length),
    }),
  );
  app.use("/*", serveStatic({ root: WEB_DIST_DIR }));

  return app;
}
