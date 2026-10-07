import { execFileSync } from "node:child_process";
import { defineConfig } from "wxt";
import { type AppConfig, CONFIG_PATH, loadAppConfig } from "./src/contract/config";

// The extension learns the bucket origin and its capture settings from
// pdf-bucket.config.json at build time, and its own version, which the manifest carries too;
// src/extension/bucket-config.ts reads this define.
export function extensionDefine(config: AppConfig): Record<string, string> {
  return {
    PDF_BUCKET_BUILD: JSON.stringify({
      bucketOrigin: `http://${config.server.host}:${config.server.port}`,
      minFrameWidth: config.capture.min_frame_width,
      minFrameHeight: config.capture.min_frame_height,
      linkOriginMaxAgeMs: config.capture.link_origin_max_age_seconds * 1000,
      nativeOpenTimeoutMs: config.capture.native_open_timeout_seconds * 1000,
      version: extensionVersion(),
    }),
  };
}

// The extension's version counts the commits of the checkout it is built from: each commit's
// build has its own version and a later commit a greater one. Firefox updates an add-on only to
// a greater version, and addons.mozilla.org signs each version once.
function extensionVersion(): string {
  const commits = execFileSync("git", ["rev-list", "--count", "HEAD"], { encoding: "utf8" });
  return `1.0.${commits.trim()}`;
}

// Interception permissions follow mozilla/pdf.js extensions/chromium/manifest.json for
// Chrome (declarativeNetRequest with response-header conditions, Chrome 128+) and the
// blocking webRequest route for Firefox, which has no response-header rule condition. Both
// observe navigation redirects through webRequest, to carry a link's origin to the PDF URL.
export default defineConfig({
  srcDir: "src/extension",
  // `just provision` builds both here, installs them beside the app and removes them.
  outDir: "dist",
  imports: false,
  vite: () => ({ define: extensionDefine(loadAppConfig(CONFIG_PATH)) }),
  manifest: ({ browser }) => ({
    name: "PDF Bucket",
    version: extensionVersion(),
    permissions:
      browser === "firefox"
        ? ["webRequest", "webRequestBlocking", "downloads", "storage", "alarms"]
        : [
            "declarativeNetRequestWithHostAccess",
            "webRequest",
            "downloads",
            "scripting",
            "storage",
            "alarms",
          ],
    // The toolbar popup doubles as the options page, which holds the capture switch.
    options_ui: { page: "popup.html", open_in_tab: false },
    host_permissions: ["<all_urls>"],
    // The capture page shows a capture's outcome in the web page's own frame: Chrome's background
    // navigates the frame there (`scripting`), and Firefox's interception answers the frame with a
    // document that opens it, so the page must be web-accessible. Any web page can therefore frame
    // it with a PDF URL of its choice; it then captures nothing (exemptions.ts,
    // firefox-interception.ts). Firefox (MV2) takes a plain list of resources, which WXT derives
    // from this.
    web_accessible_resources: [
      { resources: ["capture.html"], matches: ["http://*/*", "https://*/*"] },
    ],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: loadAppConfig(CONFIG_PATH).capture.firefox_addon_id,
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : { minimum_chrome_version: "128" }),
  }),
});
