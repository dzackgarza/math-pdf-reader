# /// script
# requires-python = ">=3.14"
# dependencies = ["playwright>=1.55", "selenium>=4.25", "cyclopts>=4"]
# ///
"""Screenshot every library state against seeded bucket stores, and time the 1,000-item load.

Builds three bucket roots in a temporary directory: an empty one, one holding a PDF without
embedded provenance (the error state), and one seeded with 1,000 PDFs through the real store
(`scripts/seed_bucket.py`, from committed fixture PDFs). Serves each with `pdf-bucket
serve` (the app's server without its window) on a free port, files part of the seeded library through the library
API, lays the committed MinerU output beside one item as its extraction, then captures each
screen in the system Chromium driven by Playwright, and the library and reader in the system
WebKitGTK (the engine of the desktop window) through WebKitWebDriver on a headless Weston. Prints the load and filter timings as JSON.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

from cyclopts import App
from playwright.sync_api import Page, Route, sync_playwright
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions
from selenium.webdriver.support.wait import WebDriverWait

REPO = Path(__file__).resolve().parents[1]
SEEDED_COUNT = 1000
VIEWPORT = {"width": 1600, "height": 1000}
FILED_COUNT = 300
SHIPPED_EXTRACTIONS = REPO / "plugins/manifests/extractions.json"
SHIPPED_RESOLVERS = REPO / "plugins/manifests/resolvers.json"
SERVER = REPO / "target/debug/pdf-bucket"

app = App()


def project_env() -> dict[str, str]:
    """The environment without this script's virtualenv, so `uv run` uses the project's."""
    return {name: value for name, value in os.environ.items() if name != "VIRTUAL_ENV"}


def closed_port_url() -> str:
    """A loopback URL nothing listens on, so a Zotero request fails instead of writing anywhere."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}"


def serve(stack: ExitStack, root: Path, zotero_url: str, extractions: Path) -> str:
    """Start the bucket server over ROOT on a free port, with Zotero at ZOTERO_URL and the extraction
    plugins listed in EXTRACTIONS; return its origin. It serves until its standard input closes, and
    rewrites the index export beside ROOT."""
    subprocess.run(["cargo", "build", "--quiet", "--package", "pdf-bucket", "--bin", "pdf-bucket"], cwd=REPO, check=True)
    index_export = root.parent / f"{root.name}-export" / "index.json"
    process = subprocess.Popen(
        [SERVER, "serve", root, zotero_url, extractions, SHIPPED_RESOLVERS, "--index-export", index_export],
        cwd=REPO,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        env=project_env(),
    )
    stack.callback(process.terminate)
    assert process.stdout is not None
    return process.stdout.readline().strip()


def call(origin: str, method: str, path: str, body: dict[str, object] | None = None) -> dict[str, object]:
    data = None if body is None else json.dumps(body).encode()
    request = Request(f"{origin}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    with urlopen(request) as response:
        return json.loads(response.read())


def timed_library_load(origin: str) -> tuple[float, dict[str, object]]:
    started = time.perf_counter()
    payload = call(origin, "GET", "/api/library")
    return time.perf_counter() - started, payload


def record_readings(origin: str, items: list[dict[str, object]]) -> None:
    """Report reading sessions for recent items, as the reader does: a morning's reading, a
    return to the first paper within half an hour (the timeline joins the two), a short look
    the timeline's default minimum hides, and an afternoon's reading."""
    first, second, third, fourth = (str(item["id"]) for item in items[:4])
    sessions = [
        (first, "2026-09-24T09:00:00Z", "2026-09-24T09:40:00Z", [(1, 600), (2, 900), (3, 700)]),
        (second, "2026-09-24T09:42:00Z", "2026-09-24T09:44:00Z", [(1, 20)]),
        (first, "2026-09-24T09:50:00Z", "2026-09-24T10:10:00Z", [(4, 800), (5, 400)]),
        (third, "2026-09-24T14:00:00Z", "2026-09-24T14:25:00Z", [(1, 300), (7, 1100)]),
        (fourth, "2026-09-24T16:30:00Z", "2026-09-24T16:36:00Z", [(2, 360)]),
    ]
    for key, opened, last_seen, pages in sessions:
        report = {
            "id": str(uuid.uuid4()),
            "key": key,
            "openedAt": opened,
            "lastSeenAt": last_seen,
            "pages": [{"page": page, "seconds": seconds} for page, seconds in pages],
        }
        call(origin, "POST", "/api/reading-sessions", report)


def file_library(origin: str, items: list[dict[str, object]]) -> dict[str, str]:
    """File the most recent items into collections, topics and tags; return the ids used later."""

    def collection(name: str, parent: str | None = None) -> str:
        body: dict[str, object] = {"name": name} if parent is None else {"name": name, "parentId": parent}
        return str(call(origin, "POST", "/api/collections", body)["id"])

    birational = collection("Birational Geometry")
    flips = collection("Flips", birational)
    threefolds = collection("Threefolds", birational)
    lattices = collection("Lattices and Quadratic Forms")
    moduli = collection("Moduli")
    to_read = collection("To Read")

    rules: list[tuple[str, list[str], list[str]]] = [
        ("flips", [flips], ["MMP", "topic:Birational Geometry"]),
        ("Fano threefolds", [threefolds], ["Fano", "topic:Birational Geometry"]),
        ("log canonical", [birational], ["MMP", "singularities", "topic:Birational Geometry"]),
        ("Mori dream", [birational], ["topic:Birational Geometry"]),
        ("lattices", [lattices], ["topic:Lattices"]),
        ("quadratic forms", [lattices], ["topic:Lattices", "arithmetic"]),
        ("K3", [moduli], ["topic:K3 Surfaces", "surfaces"]),
        ("Enriques", [moduli], ["topic:K3 Surfaces", "surfaces"]),
        ("moduli of curves", [moduli], ["topic:Moduli"]),
        ("Coxeter", [lattices], ["reflection groups", "topic:Lattices"]),
        ("Weyl", [lattices], ["reflection groups"]),
    ]
    recent = sorted(items, key=lambda item: str(item["dateAdded"]), reverse=True)[:FILED_COUNT]
    for index, item in enumerate(recent):
        title = str(item["title"])
        matched = [rule for rule in rules if rule[0] in title]
        tags = [tag for _, _, rule_tags in matched for tag in rule_tags]
        collections = [cid for _, rule_collections, _ in matched for cid in rule_collections]
        if title.startswith(("A survey", "Lectures")):
            tags.append("survey")
        if index % 7 == 0:
            collections.append(to_read)
        if tags:
            call(origin, "POST", "/api/bulk/tags", {"keys": [item["id"]], "add": tags, "remove": []})
        if collections:
            call(origin, "POST", "/api/bulk/collections", {"keys": [item["id"]], "add": collections, "remove": []})
    for note, item in zip(
        [
            "Section 3 reduces the bound to the flip termination argument; check Lemma 3.4.",
            "Compare the cone description with the Coxeter diagram computed last week.",
        ],
        recent[:2],
        strict=True,
    ):
        call(origin, "POST", f"/api/items/{quote(str(item['id']))}/notes", {"note": note})

    fields = {"title": True, "source": False, "pdfUrl": False, "tags": True, "notes": True, "key": False}
    flips_search = call(
        origin,
        "POST",
        "/api/saved-searches",
        {"name": "Flips and the MMP", "match": "all", "rules": [{"field": "text", "operator": "matches", "search": {"query": "flips", "matchCase": False, "matchType": "all", "searchFields": fields}}]},
    )
    call(
        origin,
        "POST",
        "/api/saved-searches",
        {
            "name": "Surveys and lectures",
            "match": "all",
            "rules": [{"field": "text", "operator": "matches", "search": {"query": "survey lectures", "matchCase": False, "matchType": "any", "searchFields": fields}}],
        },
    )
    return {
        "birational": birational,
        "saved": str(flips_search["id"]),
        "reader": str(recent[0]["id"]),
        "title": str(recent[0]["title"]),
        "extracted": str(recent[1]["id"]),
    }


def place_extraction(root: Path, key: str) -> None:
    """Lay out the committed MinerU output as the extraction runner does: artifacts first,
    the Markdown last."""
    shipped = REPO / "tests/fixtures/mineru-ten-page-notes"
    (root / f"{key}.extraction").mkdir()
    for name in ("content_list.json", "layout.json"):
        shutil.copy(shipped / name, root / f"{key}.extraction" / name)
    shutil.copy(shipped / "full.md", root / f"{key}.md")


def system_chromium() -> str:
    """The system Chromium, so the run downloads no browser."""
    path = shutil.which("chromium")
    assert path is not None, "chromium is not on PATH"
    return path


def shoot(page: Page, out: Path, name: str) -> None:
    page.screenshot(path=out / f"{name}.png")


def chromium_screens(out: Path, origins: dict[str, str], filed: dict[str, str]) -> dict[str, float]:
    timings: dict[str, float] = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=system_chromium())
        page = browser.new_page(viewport=VIEWPORT)

        page.goto(origins["empty"])
        page.get_by_text("No PDFs yet").wait_for()
        shoot(page, out, "library-empty")

        page.goto(origins["broken"])
        page.get_by_role("alert").wait_for()
        shoot(page, out, "library-error")

        held: list[Route] = []
        page.route("**/api/library", lambda route: held.append(route))
        page.goto(origins["seeded"])
        page.get_by_role("status").wait_for()
        shoot(page, out, "library-loading")
        for route in held:
            route.continue_()
        page.unroute("**/api/library")

        started = time.perf_counter()
        page.goto(origins["seeded"])
        page.locator("tbody tr").nth(SEEDED_COUNT - 1).wait_for(state="attached")
        timings["window_load_to_1000_rows_s"] = time.perf_counter() - started

        page.get_by_role("row").filter(has_text=filed["title"]).first.click()
        page.get_by_role("complementary", name="Item details").wait_for()
        shoot(page, out, "library-populated")

        page.get_by_role("row").nth(2).click()
        page.get_by_role("complementary", name="Item details").get_by_text("content_list.json").wait_for()
        shoot(page, out, "inspector-extraction")
        page.get_by_role("row").filter(has_text=filed["title"]).first.click()

        page.get_by_role("tab", name="Notes").click()
        shoot(page, out, "inspector-notes")
        page.get_by_role("tab", name="Details").click()

        search = page.get_by_role("searchbox", name="Search")
        started = time.perf_counter()
        search.fill("flips mmp")
        page.wait_for_function("document.querySelectorAll('tbody tr').length < 1000")
        timings["filter_1000_items_s"] = time.perf_counter() - started
        shoot(page, out, "library-filtered")

        page.get_by_role("button", name="Filters").click()
        page.get_by_role("dialog").wait_for()
        shoot(page, out, "filters")
        page.keyboard.press("Escape")
        search.fill("")

        details = page.get_by_role("complementary", name="Item details")
        details.get_by_role("button", name="Add tag").click()
        page.get_by_role("combobox", name="Tag").fill("reread")
        page.keyboard.press("Enter")
        details.get_by_role("button", name="Remove reread").wait_for()
        shoot(page, out, "inspector-tag-added")

        page.get_by_role("button", name="New collection").click()
        page.get_by_role("dialog").get_by_role("textbox").fill("Reading Group")
        shoot(page, out, "dialog-new-collection")
        page.get_by_role("dialog").get_by_role("button", name="Create").click()
        page.get_by_role("heading", name="Reading Group").wait_for()
        shoot(page, out, "organization-new-collection")
        page.goto(origins["seeded"])
        page.get_by_role("row").nth(1).wait_for()

        page.keyboard.press("Control+p")
        page.get_by_placeholder("Go to PDF").fill("cone conjecture")
        shoot(page, out, "palette-items")
        page.keyboard.press("Escape")
        page.keyboard.press("Control+Shift+P")
        page.get_by_placeholder("Command").wait_for()
        shoot(page, out, "palette-commands")
        page.keyboard.press("Escape")

        page.goto(f"{origins['seeded']}/#/organization/collections/{filed['birational']}")
        page.get_by_role("row").nth(1).click()
        shoot(page, out, "organization-collections")
        page.goto(f"{origins['seeded']}/#/organization/topics/{quote('topic:Birational Geometry', safe='')}")
        page.get_by_role("row").nth(1).wait_for()
        shoot(page, out, "organization-topics")
        page.goto(f"{origins['seeded']}/#/organization/tags")
        page.get_by_role("region", name="Tags").wait_for()
        shoot(page, out, "organization-tags")
        page.goto(f"{origins['seeded']}/#/organization/saved/{filed['saved']}")
        page.get_by_role("row").nth(1).wait_for()
        shoot(page, out, "organization-saved")

        page.goto(f"{origins['seeded']}/#/settings")
        page.get_by_text("Library folder").wait_for()
        shoot(page, out, "settings")

        page.goto(f"{origins['seeded']}/#/timeline")
        page.locator("[data-timeline-key]").first.wait_for()
        shoot(page, out, "timeline")

        page.goto(f"{origins['seeded']}/read/{quote(filed['reader'])}")
        page.frame_locator("iframe").locator(".page canvas").first.wait_for()
        page.wait_for_timeout(500)
        shoot(page, out, "reader")

        # Two PDFs open in tabs after the Library tab, the second one shown.
        page.goto(origins["seeded"])
        first = page.locator(f"tbody tr:not([data-item-id='{filed['reader']}'])").first
        first_key = first.get_attribute("data-item-id")
        first.dblclick()
        page.frame_locator(f"iframe[data-reader-key='{first_key}']").frame_locator("iframe").locator(".page canvas").first.wait_for()
        page.get_by_role("tab", name="Library", exact=True).click()
        page.locator(f"tr[data-item-id='{filed['reader']}']").dblclick()
        page.frame_locator(f"iframe[data-reader-key='{filed['reader']}']").frame_locator("iframe").locator(".page canvas").first.wait_for()
        page.wait_for_timeout(500)
        shoot(page, out, "tabs")
        dark_screens(browser.new_page(viewport=VIEWPORT, color_scheme="dark"), out, origins, filed)
        browser.close()
    return timings


def dark_screens(page: Page, out: Path, origins: dict[str, str], filed: dict[str, str]) -> None:
    """The main screens under a dark system setting, with the theme preference at its default."""
    page.goto(origins["seeded"])
    page.get_by_role("row").filter(has_text=filed["title"]).first.click()
    page.get_by_role("complementary", name="Item details").wait_for()
    shoot(page, out, "dark-library-populated")
    page.get_by_role("tab", name="Notes").click()
    shoot(page, out, "dark-inspector-notes")
    page.get_by_role("tab", name="Details").click()

    page.get_by_role("button", name="Filters").click()
    page.get_by_role("dialog").wait_for()
    shoot(page, out, "dark-filters")
    page.keyboard.press("Escape")

    page.keyboard.press("Control+p")
    page.get_by_placeholder("Go to PDF").fill("cone conjecture")
    shoot(page, out, "dark-palette-items")
    page.keyboard.press("Escape")

    page.goto(f"{origins['seeded']}/#/organization/collections/{filed['birational']}")
    page.get_by_role("row").nth(1).click()
    shoot(page, out, "dark-organization-collections")

    page.goto(f"{origins['seeded']}/#/settings")
    page.get_by_text("Library folder").wait_for()
    shoot(page, out, "dark-settings")

    page.goto(f"{origins['seeded']}/#/timeline")
    page.locator("[data-timeline-key]").first.wait_for()
    shoot(page, out, "dark-timeline")

    page.goto(f"{origins['seeded']}/read/{quote(filed['reader'])}")
    page.frame_locator("iframe").locator(".page canvas").first.wait_for()
    page.wait_for_timeout(500)
    shoot(page, out, "dark-reader")


def headless_display(stack: ExitStack) -> str:
    """A headless Weston whose kiosk shell fills its 1400x900 output (the desktop window size)
    with each window; returns its Wayland socket name. Weston's log goes to a temporary file
    that is printed on stderr if Weston has exited by the time the screens are done."""
    socket = f"pdf-bucket-evidence-{os.getpid()}"
    log = stack.enter_context(tempfile.TemporaryFile(mode="w+"))
    weston = subprocess.Popen(
        ["weston", "--backend=headless", "--shell=kiosk", "--renderer=pixman", "--width=1400", "--height=900", f"--socket={socket}"],
        stdout=log,
        stderr=subprocess.STDOUT,
    )

    def weston_log() -> str:
        log.seek(0)
        return log.read()

    def stop() -> None:
        if weston.poll() is not None:
            print(f"weston exited with {weston.returncode}:\n{weston_log()}", file=sys.stderr)
            return
        weston.terminate()

    stack.callback(stop)
    socket_path = Path(os.environ["XDG_RUNTIME_DIR"]) / socket
    while not socket_path.exists():
        if weston.poll() is not None:
            raise RuntimeError(f"weston exited with {weston.returncode} before creating {socket_path}")
        time.sleep(0.1)
    return socket


def webkit_screens(stack: ExitStack, out: Path, origins: dict[str, str], filed: dict[str, str]) -> None:
    """The library and the reader in the system WebKitGTK, the engine of the desktop window.
    WebKitGTK takes prefers-color-scheme from GTK, which on Wayland reads the desktop's
    org.gnome.desktop.interface color-scheme; the in-memory GSettings backend holds the schema
    default (light), so the Dark preference's screenshots show the preference, not the desktop's
    setting."""
    env = {**os.environ, "WAYLAND_DISPLAY": headless_display(stack), "GDK_BACKEND": "wayland", "GSETTINGS_BACKEND": "memory"}
    options = webdriver.WebKitGTKOptions()
    options.binary_location = "/usr/lib/webkit2gtk-4.1/MiniBrowser"
    options.add_argument("--automation")
    service = webdriver.WebKitGTKService(executable_path="/usr/bin/WebKitWebDriver", env=env)
    driver = webdriver.WebKitGTK(options=options, service=service)
    wait = WebDriverWait(driver, 30)
    driver.get(origins["seeded"])
    cell = f"//tbody/tr[contains(., {json.dumps(filed['title'])})]/td[@data-column='title']"
    row = wait.until(expected_conditions.element_to_be_clickable((By.XPATH, cell)))
    row.click()
    wait.until(expected_conditions.presence_of_element_located((By.CSS_SELECTOR, "aside[aria-label='Item details']")))
    driver.save_screenshot(str(out / "webkit-library-populated.png"))
    driver.get(f"{origins['seeded']}/read/{quote(filed['reader'])}")
    # The reader rewrites its own address as the view changes, which ends a WebDriver frame
    # context; the viewer is same-origin, so the page itself reports when PDF.js has drawn.
    wait.until(lambda d: d.execute_script("return document.querySelector('iframe').contentDocument?.querySelector('.page canvas') != null"))
    time.sleep(0.5)
    driver.save_screenshot(str(out / "webkit-reader.png"))

    # The same PDF opened from the library, in its tab.
    driver.get(origins["seeded"])
    reader_cell = f"//tbody/tr[@data-item-id={json.dumps(filed['reader'])}]/td[@data-column='title']"
    ActionChains(driver).double_click(wait.until(expected_conditions.element_to_be_clickable((By.XPATH, reader_cell)))).perform()
    tab_canvas = f"return document.querySelector(\"iframe[data-reader-key='{filed['reader']}']\")?.contentDocument?.querySelector('iframe')?.contentDocument?.querySelector('.page canvas') != null"
    wait.until(lambda d: d.execute_script(tab_canvas))
    time.sleep(0.5)
    driver.save_screenshot(str(out / "webkit-tabs.png"))

    # The Dark preference over the light GTK theme.
    call(origins["seeded"], "PATCH", "/api/preferences", {"theme": "dark"})
    driver.get(origins["seeded"])
    row = wait.until(expected_conditions.element_to_be_clickable((By.XPATH, cell)))
    row.click()
    wait.until(expected_conditions.presence_of_element_located((By.CSS_SELECTOR, "aside[aria-label='Item details']")))
    driver.save_screenshot(str(out / "webkit-dark-library-populated.png"))
    call(origins["seeded"], "PATCH", "/api/preferences", {"theme": "system"})
    driver.quit()


@app.default
def main(out: Path) -> None:
    """Write the screenshots into OUT and print the timings."""
    out.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        scratch = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="pdf-bucket-evidence-")))
        roots = {name: scratch / name for name in ("empty", "broken", "seeded")}
        for root in roots.values():
            root.mkdir()
        shutil.copy(REPO / "tests/fixtures/problem-set.pdf", roots["broken"] / "hand-copied.pdf")
        started = time.perf_counter()
        subprocess.run(["uv", "run", "--locked", "python", "scripts/seed_bucket.py", str(roots["seeded"]), str(SEEDED_COUNT)], cwd=REPO, check=True, env=project_env())
        seed_seconds = time.perf_counter() - started

        started = time.perf_counter()
        subprocess.run(
            ["uv", "run", "--locked", "pdfbucket", "list", str(roots["seeded"])],
            cwd=REPO,
            check=True,
            env=project_env(),
            stdout=subprocess.DEVNULL,
        )
        list_seconds = time.perf_counter() - started

        origins = {name: serve(stack, root, closed_port_url(), SHIPPED_EXTRACTIONS) for name, root in roots.items()}
        cold, payload = timed_library_load(origins["seeded"])
        warm, _ = timed_library_load(origins["seeded"])
        items = payload["items"]
        assert isinstance(items, list)
        assert len(items) == SEEDED_COUNT, f"seeded library lists {len(items)} items"
        filed = file_library(origins["seeded"], items)
        place_extraction(roots["seeded"], filed["extracted"])
        record_readings(origins["seeded"], sorted(items, key=lambda item: str(item["dateAdded"]), reverse=True))

        timings = {
            "seed_1000_pdfs_s": seed_seconds,
            "store_list_1000_s": list_seconds,
            "api_library_cold_s": cold,
            "api_library_warm_s": warm,
        }
        timings |= chromium_screens(out, origins, filed)
        webkit_screens(stack, out, origins, filed)
    print(json.dumps({name: round(value, 3) for name, value in timings.items()}, indent=2))


def capture_fixture(root: Path, fixture: str, key: str, pdf_url: str, source_url: str, title: str) -> None:
    command = ["uv", "run", "--locked", "pdfbucket", "capture", str(root), f"tests/fixtures/{fixture}", f"{key}.pdf", pdf_url, source_url, title]
    subprocess.run(command, cwd=REPO, check=True, env=project_env(), stdout=subprocess.DEVNULL)


def record_sent(root: Path, key: str) -> None:
    """File KEY as a complete send, as the send action records one in the filing document."""
    record = {
        "itemKey": "Q7ZK3M2P",
        "sentAt": "2026-09-23T18:00:00.000Z",
        "source": {"kind": "resolver", "pluginId": "arxiv", "identifier": "https://arxiv.org/abs/2609.21174v1"},
        "steps": [{"step": "fields"}, {"step": "pdf", "attachmentKey": "H4VN8TQR"}],
    }
    filing = {"tags": [], "collections": [], "notes": [], "reading": {"status": "unread"}, "sourceCheck": {"status": "unchecked"}, "mirrors": [], "modifiedAt": record["sentAt"], "zotero": record}
    organization = {"version": 2, "collections": [], "savedSearches": [], "items": {key: filing}, "activity": [], "preferences": {"outlineOnOpen": False, "theme": "system"}}
    (root / "organization.json").write_text(json.dumps(organization))


@app.command
def send(out: Path) -> None:
    """Screenshot the send action's states into OUT against a bucket whose Zotero never answers."""
    out.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="pdf-bucket-send-")))
        capture_fixture(
            root,
            "lecture-notes.pdf",
            "lecture-notes",
            "https://www.math.example.edu/~author/lecture-notes.pdf",
            "https://www.math.example.edu/~author/teaching.html",
            "Lattices and Quadratic Forms",
        )
        capture_fixture(
            root,
            "arxiv-2609.21174v1.pdf",
            "2609.21174v1",
            "https://arxiv.org/pdf/2609.21174v1",
            "https://arxiv.org/abs/2609.21174v1",
            "On The Cyclicity of Algebraic Lattices",
        )
        record_sent(root, "2609.21174v1")
        origin = serve(stack, root, closed_port_url(), SHIPPED_EXTRACTIONS)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=system_chromium())
            page = browser.new_page(viewport=VIEWPORT)
            page.goto(origin)
            details = page.get_by_role("complementary", name="Item details")

            page.get_by_role("row").filter(has_text="Lattices and Quadratic Forms").click()
            details.get_by_role("button", name="Send to Zotero").wait_for()
            shoot(page, out, "send-idle")

            held: list[Route] = []
            page.route("**/api/items/*/zotero", lambda route: held.append(route))
            details.get_by_role("button", name="Send to Zotero").click()
            details.get_by_role("button", name="Send to Zotero", disabled=True).wait_for()
            shoot(page, out, "send-sending")
            for route in held:
                route.continue_()
            page.unroute("**/api/items/*/zotero")
            details.get_by_role("alert").wait_for()
            shoot(page, out, "send-failed")

            page.get_by_role("row").filter(has_text="On The Cyclicity").click()
            page.keyboard.press("Control+Shift+P")
            page.get_by_placeholder("Command").fill("Send Selected")
            page.keyboard.press("Enter")
            details.get_by_role("alert").wait_for()
            shoot(page, out, "send-refused")
            browser.close()


def fixture_extractions(directory: Path) -> Path:
    """A manifest of the committed fixture extractor in three modes: one that writes Markdown and
    an artifact, one that fails with a message on stderr, one limited to five pages."""
    extractor = str(REPO / "tests/fixtures/plugins/extractor.sh")

    def plugin(mode: str, name: str, max_pages: int) -> dict[str, object]:
        limits = [{"kind": "max_pages", "value": max_pages}]
        return {
            "id": mode,
            "name": name,
            "command": ["sh", extractor, mode, "$pdf", "$output"],
            "accepted_inputs": [{"kind": "pdf", "id": "pdf", "label": f"PDF up to {max_pages} pages", "limits": limits}],
        }

    manifest = directory / "extractions.json"
    plugins = [
        plugin("record", "Fixture: writes files", 20),
        plugin("fail", "Fixture: fails", 20),
        plugin("markdown", "Fixture: 5 pages max", 5),
    ]
    manifest.write_text(json.dumps({"plugins": plugins}))
    return manifest


@app.command
def extract(out: Path) -> None:
    """Screenshot the inspector's extraction runs into OUT against the committed fixture extractor."""
    out.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        scratch = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="pdf-bucket-extract-")))
        root = scratch / "bucket"
        root.mkdir()
        homepage = "https://www.math.example.edu/~author/"
        capture_fixture(root, "lecture-notes.pdf", "lecture-notes", f"{homepage}lecture-notes.pdf", f"{homepage}teaching.html", "Lattices and Quadratic Forms")
        capture_fixture(root, "ten-page-notes.pdf", "ten-page-notes", f"{homepage}ten-page-notes.pdf", f"{homepage}teaching.html", "Ten Lectures on Integral Lattices")
        origin = serve(stack, root, closed_port_url(), fixture_extractions(scratch))

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=system_chromium())
            page = browser.new_page(viewport=VIEWPORT)
            page.goto(origin)
            details = page.get_by_role("complementary", name="Item details")
            plugin = details.get_by_label("Extraction plugin")

            page.get_by_role("row").filter(has_text="Lattices and Quadratic Forms").click()
            details.get_by_role("button", name="Run extraction").wait_for()
            shoot(page, out, "extract-idle")

            held: list[Route] = []
            page.route("**/api/items/*/extractions/*", lambda route: held.append(route))
            details.get_by_role("button", name="Run extraction").click()
            details.get_by_role("button", name="Run extraction", disabled=True).wait_for()
            shoot(page, out, "extract-running")
            for route in held:
                route.continue_()
            page.unroute("**/api/items/*/extractions/*")
            details.get_by_text("artifacts/source.pdf").or_(details.get_by_text("source.pdf")).first.wait_for()
            shoot(page, out, "extract-succeeded")

            page.get_by_role("row").filter(has_text="Ten Lectures on Integral Lattices").click()
            plugin.select_option("fail")
            details.get_by_role("button", name="Run extraction").click()
            details.get_by_role("alert").wait_for()
            shoot(page, out, "extract-failed")

            plugin.select_option("markdown")
            details.get_by_role("button", name="Run extraction").click()
            details.get_by_role("alert").filter(has_text="did not run").wait_for()
            shoot(page, out, "extract-rejected")
            browser.close()
        print(json.dumps(sorted(path.name for path in root.iterdir())))


if __name__ == "__main__":
    app()
