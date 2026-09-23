// Declared config surface: one JSON file, strict schema, no runtime defaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { xdgData } from "xdg-basedir";
import { z } from "zod";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CONFIG_PATH = join(REPO_ROOT, "pdf-bucket.config.json");
export const WEB_DIST_DIR = join(REPO_ROOT, "dist/web");

// The Python store package owns provenance embedding and the folder layout.
export const STORE_COMMAND = ["uv", "run", "--project", REPO_ROOT, "--locked", "pdfbucket"];

export const AppConfigSchema = z.strictObject({
  server: z.strictObject({
    host: z.string().min(1),
    port: z.number().int().positive(),
  }),
  pdfjs: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  // Sub-frames smaller than this keep the browser's own viewer (embedded previews).
  capture: z.strictObject({
    min_frame_width: z.number().int().positive(),
    min_frame_height: z.number().int().positive(),
  }),
  // Zotero's local HTTP server; the send action writes through its local write API.
  zotero: z.strictObject({ url: z.url({ protocol: /^http$/ }) }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadAppConfig(configPath: string): AppConfig {
  return AppConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
}

// The prebuilt PDF.js viewer, unpacked from the pinned release by `just fetch-pdfjs`.
export function pdfjsDir(config: AppConfig): string {
  return join(REPO_ROOT, "vendor", `pdfjs-${config.pdfjs.version}`);
}

// Permanent data (stored PDFs, the library index) lives in the XDG data directory:
// $XDG_DATA_HOME/pdf-bucket, which is ~/.local/share/pdf-bucket when XDG_DATA_HOME is unset.
export function dataRoot(): string {
  if (xdgData === undefined) {
    throw new Error("no XDG data directory: neither XDG_DATA_HOME nor HOME is set");
  }
  return join(xdgData, "pdf-bucket");
}
