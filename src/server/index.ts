import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "./config";

const VERSION = "0.1.0";

const config = loadAppConfig(CONFIG_PATH);
mkdirSync(config.root, { recursive: true });
const viewer = join(pdfjsDir(config), "web/viewer.html");
if (!existsSync(viewer)) {
  throw new Error(`PDF.js viewer missing at ${viewer}; run \`just fetch-pdfjs\``);
}

export default {
  port: config.server.port,
  hostname: config.server.host,
  fetch: createApp({ root: config.root, version: VERSION, pdfjsDir: pdfjsDir(config) }).fetch,
};
