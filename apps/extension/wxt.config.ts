import { defineConfig } from "wxt";

// Interception permissions follow mozilla/pdf.js extensions/chromium/manifest.json for
// Chrome (declarativeNetRequest with response-header conditions, Chrome 128+) and the
// blocking webRequest route for Firefox, which has no response-header rule condition.
export default defineConfig({
  manifest: ({ browser }) => ({
    name: "PDF Bucket",
    permissions:
      browser === "firefox"
        ? ["webRequest", "webRequestBlocking", "storage"]
        : ["declarativeNetRequestWithHostAccess", "storage"],
    host_permissions: ["<all_urls>"],
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
