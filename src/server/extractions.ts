// Extraction plugins: the manifest listing, and runs on stored items through the Python
// runner (`pdfbucket extract`), which places `<key>.md` and `<key>.extraction/` beside the PDF.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  ExtractionOutcomeSchema,
  type ExtractionPluginsResponse,
  PluginManifestSchema,
} from "../contract/extraction";
import { REPO_ROOT } from "./config";
import { runStore, storedPdfPath } from "./store";

export const EXTRACTIONS_MANIFEST = join(REPO_ROOT, "plugins/manifests/extractions.json");

// A plugin that exits non-zero is a failed upstream; a PDF outside its limits is unprocessable.
const OUTCOME_STATUS = { succeeded: 200, failed: 502, rejected: 422 } as const;

export function registerExtractionRoutes(app: Hono, root: string, manifestPath: string): void {
  const manifest = () => PluginManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));

  app.get("/api/plugins/extractions", (c) => {
    const response: ExtractionPluginsResponse = {
      plugins: manifest().plugins.map(({ id, name, accepted_inputs }) => ({
        id,
        name,
        accepted_inputs,
      })),
    };
    return c.json(response);
  });

  app.post("/api/items/:key/extractions/:pluginId", async (c) => {
    const key = c.req.param("key");
    const pluginId = c.req.param("pluginId");
    if (storedPdfPath(root, key) === null) {
      return c.json(
        { error: { kind: "unknown_item", message: `no stored PDF has key ${key}` } },
        404,
      );
    }
    if (!manifest().plugins.some((plugin) => plugin.id === pluginId)) {
      const message = `no extraction plugin has id ${pluginId}`;
      return c.json({ error: { kind: "unknown_plugin", message } }, 404);
    }
    const stdout = await runStore(["extract", root, key, manifestPath, pluginId], "ignore");
    const outcome = ExtractionOutcomeSchema.parse(JSON.parse(stdout));
    return c.json(outcome, OUTCOME_STATUS[outcome.status]);
  });
}
