import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { CONFIG_PATH, dataRoot, loadAppConfig, pdfjsDir } from "./config";

const VERSION = "0.1.0";

const config = loadAppConfig(CONFIG_PATH);
const root = dataRoot();
mkdirSync(root, { recursive: true });
const viewer = join(pdfjsDir(config), "web/viewer.html");
if (!existsSync(viewer)) {
  throw new Error(`PDF.js viewer missing at ${viewer}; run \`just fetch-pdfjs\``);
}

export default {
  port: config.server.port,
  hostname: config.server.host,
  // Extraction requests stay open for minutes while a provider works; 0 disables the timeout.
  idleTimeout: 0,
  fetch: createApp({ root, version: VERSION, pdfjsDir: pdfjsDir(config) }).fetch,
};
