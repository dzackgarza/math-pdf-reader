// First-page thumbnails: rendered by the store (MuPDF) into the cache directory, one PNG per
// item and width, drawn again whenever the PDF is newer than its PNG (a reader save, a rebuild).
import { existsSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Semaphore } from "async-mutex";
import type { Hono } from "hono";
import { z } from "zod";
import { cacheRoot } from "./config";
import { apiError, invalid } from "./library";
import { runStore, storedPdfPath } from "./store";

const WidthSchema = z.coerce.number().int().min(16).max(2000);

// Rendering runs a store process; two at a time keep a grid of new items from starting dozens.
const renders = new Semaphore(2);

export function thumbnailRoutes(app: Hono, root: string) {
  const directory = join(cacheRoot(), "thumbnails");
  mkdirSync(directory, { recursive: true });

  app.get("/api/items/:key/thumbnail", async (c) => {
    const key = c.req.param("key");
    const width = WidthSchema.safeParse(c.req.query("width"));
    if (!width.success) {
      return invalid(c, width.error);
    }
    const pdf = storedPdfPath(root, key);
    if (pdf === null) {
      return apiError(c, 404, "unknown_item", `no stored PDF has key ${key}`);
    }
    const png = join(directory, `${encodeURIComponent(key)}-${width.data}.png`);
    if (!existsSync(png) || (await stat(png)).mtimeMs < (await stat(pdf)).mtimeMs) {
      await renders.runExclusive(() =>
        runStore(["thumbnail", "--", root, key, png, String(width.data)], "ignore"),
      );
    }
    return new Response(Bun.file(png), { headers: { "Content-Type": "image/png" } });
  });
}
