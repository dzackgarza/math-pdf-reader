import { defineConfig } from "wxt";
import { type AppConfig, CONFIG_PATH, loadAppConfig } from "./src/contract/config";

// The extension learns the bucket origin and its capture settings from
// pdf-bucket.config.json at build time; src/extension/bucket-config.ts reads this define.
export function extensionDefine(config: AppConfig): Record<string, string> {
  return {
    PDF_BUCKET_BUILD: JSON.stringify({
      bucketOrigin: `http://${config.server.host}:${config.server.port}`,
      minFrameWidth: config.capture.min_frame_width,
      minFrameHeight: config.capture.min_frame_height,
      linkOriginMaxAgeMs: config.capture.link_origin_max_age_seconds * 1000,
      nativeOpenTimeoutMs: config.capture.native_open_timeout_seconds * 1000,
    }),
  };
}

// Interception permissions follow mozilla/pdf.js extensions/chromium/manifest.json for
// Chrome (declarativeNetRequest with response-header conditions, Chrome 128+) and the
// blocking webRequest route for Firefox, which has no response-header rule condition. Both
// observe navigation redirects through webRequest, to carry a link's origin to the PDF URL.
export default defineConfig({
  srcDir: "src/extension",
  // `just build` lands both builds and the Firefox package beside the web bundle in dist/.
  outDir: "dist",
  zip: { zipSources: false },
  imports: false,
  vite: () => ({ define: extensionDefine(loadAppConfig(CONFIG_PATH)) }),
  manifest: ({ browser }) => ({
    name: "PDF Bucket",
    permissions:
      browser === "firefox"
        ? ["webRequest", "webRequestBlocking", "storage", "alarms"]
        : ["declarativeNetRequestWithHostAccess", "webRequest", "downloads", "storage", "alarms"],
    // The toolbar popup doubles as the options page, which holds the capture switch.
    options_ui: { page: "popup.html", open_in_tab: false },
    host_permissions: ["<all_urls>"],
    web_accessible_resources: [{ resources: ["capture.html"], matches: ["<all_urls>"] }],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "pdf-bucket@dzackgarza.com",
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : { minimum_chrome_version: "128" }),
  }),
});
