import { createApp } from "./app";
import { CONFIG_PATH, loadAppConfig } from "./config";

const VERSION = "0.1.0";

const config = loadAppConfig(CONFIG_PATH);

export default {
  port: config.server.port,
  hostname: config.server.host,
  fetch: createApp({ root: config.root, version: VERSION }).fetch,
};
