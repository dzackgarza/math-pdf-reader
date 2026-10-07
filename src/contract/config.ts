// Declared config surface: one JSON file, pdf-bucket.config.json, strict schema, no runtime
// defaults. The server, the extension build and the test suites read it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NonEmptySchema } from "./text";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CONFIG_PATH = join(REPO_ROOT, "pdf-bucket.config.json");

export const AppConfigSchema = z.strictObject({
  server: z.strictObject({
    host: NonEmptySchema,
    port: z.number().int().positive(),
  }),
  // The capture extension: sub-frames smaller than the minimum keep the browser's own viewer
  // (embedded previews); a followed link gives its text as the title hint for a PDF that arrives
  // within the link-origin age; the capture page reports a failure when the background has not
  // registered a native open within its timeout. Firefox knows the add-on by its id, which its
  // enterprise policy (scripts/firefox-policy.sh) names too.
  capture: z.strictObject({
    min_frame_width: z.number().int().positive(),
    min_frame_height: z.number().int().positive(),
    link_origin_max_age_seconds: z.number().int().positive(),
    native_open_timeout_seconds: z.number().int().positive(),
    firefox_addon_id: NonEmptySchema,
  }),
  // Zotero's local HTTP server; the send action writes through its local write API.
  zotero: z.strictObject({ url: z.url({ protocol: /^http$/ }) }),
  // `just rebuild-cache`: downloads at once, and how long one may take before its URL is dead.
  rebuild: z.strictObject({
    concurrent_downloads: z.number().int().positive(),
    download_timeout_seconds: z.number().int().positive(),
  }),
  // How long an extraction plugin may run before it is killed and its run reported as timed out;
  // the plugins "Send to Zotero and Extract" tries, in order, until one extracts the PDF.
  plugins: z.strictObject({
    extraction_timeout_seconds: z.number().int().positive(),
    send_extraction_chain: z.array(z.string().min(1)).min(1),
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
