// Serve the bucket app over any bucket root on a free port and print its origin:
// `bun src/server/serveBucket.ts <root> <zotero url> <extractions manifest>`. The evidence
// runs use it so that they never touch the configured bucket or its port, and write to Zotero
// and run extraction plugins only through what they name.
import { existsSync } from "node:fs";
import { createApp } from "./app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "./config";
import { RESOLVERS_MANIFEST } from "./send";

const [root, zoteroUrl, extractionsManifest] = Bun.argv.slice(2);
if (
  root === undefined ||
  !existsSync(root) ||
  zoteroUrl === undefined ||
  extractionsManifest === undefined
) {
  throw new Error(
    "usage: bun src/server/serveBucket.ts <existing bucket root> <zotero url> <extractions manifest>",
  );
}
const config = loadAppConfig(CONFIG_PATH);
const server = Bun.serve({
  hostname: config.server.host,
  port: 0,
  // A send or an extraction holds its request open while plugins and Zotero work.
  idleTimeout: 0,
  fetch: createApp({
    root,
    version: "0.1.0",
    pdfjsDir: pdfjsDir(config),
    zoteroUrl,
    extractionsManifest,
    resolversManifest: RESOLVERS_MANIFEST,
    indexExport: null,
  }).fetch,
});
process.stdout.write(`${server.url.origin}\n`);
