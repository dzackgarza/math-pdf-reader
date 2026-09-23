# /// script
# requires-python = ">=3.14"
# dependencies = ["playwright>=1.55", "cyclopts>=4"]
# ///
"""Save a bucket reader page to Zotero with the unmodified Zotero Connector.

Loads the Chromium build of the Connector installed in the user's Chromium profile into a
throwaway Chromium profile, opens the reader page, and runs the Connector's own
save-with-translator action (what its toolbar button runs once a translator has matched the
page). Prints the Zotero item that appeared, read back through Zotero's local API, and the
SHA-256 of its PDF attachment file. Writes a screenshot of the page with the Connector's
progress window.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import time
from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen

from cyclopts import App
from playwright.sync_api import sync_playwright

app = App()
ZOTERO_ITEMS = "http://127.0.0.1:23119/api/users/0/items"
CONNECTOR_ID = "ekhagklcjbdpajgpjgmbionohlpdbjgc"


def zotero_json(path: str) -> list[dict[str, dict[str, str]]]:
    with urlopen(f"{ZOTERO_ITEMS}{path}") as response:
        return json.loads(response.read())


def newest_top_item() -> dict[str, str]:
    return zotero_json("/top?limit=1&sort=dateAdded&direction=desc&format=json")[0]["data"]


@app.default
def save(reader_url: str, screenshot: Path, chromium: Path = Path("/usr/bin/chromium")) -> None:
    installed = sorted((Path.home() / ".config/chromium/Default/Extensions" / CONNECTOR_ID).iterdir())[-1]
    work = Path(tempfile.mkdtemp(prefix="connector-save-"))
    connector = work / "connector"
    # Chromium refuses to load an unpacked extension that contains the Web Store's _metadata.
    shutil.copytree(installed, connector, ignore=shutil.ignore_patterns("_metadata"))
    before = newest_top_item()["key"]

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            work / "profile",
            executable_path=chromium,
            headless=True,
            args=[f"--disable-extensions-except={connector}", f"--load-extension={connector}"],
        )
        page = context.new_page()
        page.goto(reader_url, wait_until="load")
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
        worker.evaluate(
            """async (url) => {
                const [tab] = await chrome.tabs.query({ url });
                for (let i = 0; i < 100; i++) {
                    const info = Zotero.Connector_Browser.getTabInfo(tab.id);
                    if (info.translators && info.translators.length) {
                        return Zotero.Connector_Browser.saveWithTranslator(tab, 0, { fallbackOnFailure: true });
                    }
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
                throw new Error("no Zotero translator matched " + url);
            }""",
            reader_url,
        )
        deadline = time.monotonic() + 60
        while newest_top_item()["key"] == before:
            assert time.monotonic() < deadline, "no new Zotero item appeared"
            time.sleep(1)
        time.sleep(3)
        page.screenshot(path=screenshot)
        context.close()

    item = newest_top_item()
    children = zotero_json(f"/{item['key']}/children?format=json")
    attachments = [child["data"] for child in children if child["data"].get("contentType") == "application/pdf"]
    files = [next((Path.home() / "Zotero/storage" / a["key"]).glob("*.pdf")) for a in attachments]
    print(
        json.dumps(
            {
                "item": {k: item[k] for k in ("key", "itemType", "title", "url", "accessDate", "dateAdded")},
                "attachments": [
                    {"key": a["key"], "title": a["title"], "url": a.get("url"), "sha256": sha256(f.read_bytes()).hexdigest()}
                    for a, f in zip(attachments, files, strict=True)
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    app()
