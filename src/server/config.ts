// Declared config surface, cribbed from zotero-gui (src/server/config.ts): one JSON file,
// strict schema, no runtime defaults.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const CONFIG_PATH = fileURLToPath(new URL("../../pdf-bucket.config.json", import.meta.url));

export const AppConfigSchema = z.strictObject({
  server: z.strictObject({
    host: z.string().min(1),
    port: z.number().int().positive(),
  }),
  root: z.string().min(1),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadAppConfig(configPath: string): AppConfig {
  return AppConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
}
