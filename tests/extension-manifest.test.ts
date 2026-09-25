import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "wxt";

const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the Chrome build declares the declarativeNetRequest interception route, redirect observation and download capture", async () => {
  const output = await build({ root: EXTENSION_ROOT, browser: "chrome", mode: "production" });

  expect(output.manifest.manifest_version).toBe(3);
  expect(output.manifest.permissions).toEqual([
    "declarativeNetRequestWithHostAccess",
    "webRequest",
    "downloads",
    "storage",
    "alarms",
  ]);
  expect(output.manifest.host_permissions).toEqual(["<all_urls>"]);
  expect(output.manifest.minimum_chrome_version).toBe("128");
});

test("the Firefox build declares the blocking webRequest interception route", async () => {
  const output = await build({ root: EXTENSION_ROOT, browser: "firefox", mode: "production" });

  expect(output.manifest.manifest_version).toBe(2);
  expect(output.manifest.permissions).toEqual([
    "webRequest",
    "webRequestBlocking",
    "storage",
    "alarms",
    "<all_urls>",
  ]);
});
