// Extraction plugins: the manifest listing, and runs on stored items through the Python
// runner (`pdfbucket extract`), which places `<key>.md` and `<key>.extraction/` beside the PDF.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { REPO_ROOT } from "./config";
import { runStore, storedPdfPath } from "./store";

export const EXTRACTIONS_MANIFEST = join(REPO_ROOT, "plugins/manifests/extractions.json");

const PdfLimitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("max_pages"), value: z.int().positive() }),
  z.strictObject({ kind: z.literal("max_bytes"), value: z.int().positive() }),
]);

const AcceptedInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("identifier"),
    id: z.string(),
    label: z.string(),
    example: z.string(),
    pattern: z.string(),
  }),
  z.strictObject({
    kind: z.literal("pdf"),
    id: z.string(),
    label: z.string(),
    limits: z.array(PdfLimitSchema),
  }),
]);

const PluginManifestSchema = z.strictObject({
  plugins: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      command: z.array(z.string()).min(1),
      accepted_inputs: z.array(AcceptedInputSchema),
    }),
  ),
});

export const ExtractionPluginsResponseSchema = z.strictObject({
  plugins: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      accepted_inputs: z.array(AcceptedInputSchema),
    }),
  ),
});

const ArtifactFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().nonnegative(),
});

export const ExtractionOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    markdown: ArtifactFileSchema,
    artifacts: z.array(ArtifactFileSchema),
  }),
  z.strictObject({
    status: z.literal("failed"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    exit_code: z.int(),
    stderr: z.string(),
  }),
  z.strictObject({
    status: z.literal("rejected"),
    key: z.string().min(1),
    plugin_id: z.string().min(1),
    violations: z.array(z.strictObject({ limit: PdfLimitSchema, observed: z.int() })),
  }),
]);

type ExtractionPluginsResponse = z.infer<typeof ExtractionPluginsResponseSchema>;

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
    const listed = manifest().plugins.some((plugin) => plugin.id === pluginId);
    if (storedPdfPath(root, key) === null || !listed) {
      return c.notFound();
    }
    const stdout = await runStore(["extract", root, key, manifestPath, pluginId], "ignore");
    const outcome = ExtractionOutcomeSchema.parse(JSON.parse(stdout));
    return c.json(outcome, OUTCOME_STATUS[outcome.status]);
  });
}
