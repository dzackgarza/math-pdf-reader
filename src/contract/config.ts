// Declared config surface: one JSON file, pdf-bucket.config.json, strict schema, no runtime
// defaults. The server, the extension build and the test suites read it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NonEmptySchema, Sha256Schema } from "./text";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CONFIG_PATH = join(REPO_ROOT, "pdf-bucket.config.json");

export const AppConfigSchema = z.strictObject({
  server: z.strictObject({
    host: NonEmptySchema,
    port: z.number().int().positive(),
  }),
  pdfjs: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    sha256: Sha256Schema,
  }),
  // Sub-frames smaller than this keep the browser's own viewer (embedded previews).
  capture: z.strictObject({
    min_frame_width: z.number().int().positive(),
    min_frame_height: z.number().int().positive(),
  }),
  // Zotero's local HTTP server; the send action writes through its local write API.
  zotero: z.strictObject({ url: z.url({ protocol: /^http$/ }) }),
  // `just rebuild-cache`: downloads at once, and how long one may take before its URL is dead.
  rebuild: z.strictObject({
    concurrent_downloads: z.number().int().positive(),
    download_timeout_seconds: z.number().int().positive(),
  }),
  // How long an extraction or resolver plugin may run before it is killed and its run reported
  // as timed out.
  plugins: z.strictObject({
    extraction_timeout_seconds: z.number().int().positive(),
    resolver_timeout_seconds: z.number().int().positive(),
  }),
  // How long one pikepdf command (`pdfbucket <command>`) may run before it is killed.
  store: z.strictObject({ command_timeout_seconds: z.number().int().positive() }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadAppConfig(configPath: string): AppConfig {
  return AppConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
}

// The pikepdf commands (`pdfbucket <command>`) in the checkout's Python environment; tests that
// read or set up a bucket below its HTTP API run them.
export const STORE_COMMAND = ["uv", "run", "--project", REPO_ROOT, "--locked", "pdfbucket"];
