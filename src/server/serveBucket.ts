// Serve the bucket app over any bucket root on a free port and print its origin:
// `bun src/server/serveBucket.ts <root>`. The seeded-store evidence run uses it so that it
// never touches the configured bucket or its port.
import { existsSync } from "node:fs";
import { createApp } from "./app";
import { CONFIG_PATH, loadAppConfig, pdfjsDir } from "./config";

const root = Bun.argv[2];
if (root === undefined || !existsSync(root)) {
  throw new Error("usage: bun src/server/serveBucket.ts <existing bucket root>");
}
const config = loadAppConfig(CONFIG_PATH);
const server = Bun.serve({
  hostname: config.server.host,
  port: 0,
  fetch: createApp({ root, version: "0.1.0", pdfjsDir: pdfjsDir(config) }).fetch,
});
console.log(server.url.origin);
