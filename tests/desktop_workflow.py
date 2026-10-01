"""One reading session in the desktop app, driven through its own window.

The release app (target/release/pdf-bucket-desktop) runs against a scratch data home whose
runtime files are the checkout's, on a headless Weston display, under WebKitWebDriver (Tauri's
WebDriver path on Linux). `just test-desktop` runs it in a private network namespace, so the app
can take its fixed port. pytest collects this file only when it is named on the command line.

Every step goes through the window: pointer drags over the page's text, clicks on the reader's
and the library's controls, typing into the inspector. The state is read from the frames by
script, because the reader rewrites its address on every view change, which ends WebDriver frame
contexts. The stored PDFs are checked at the end with pikepdf, not through the app.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path

import pikepdf
import pytest
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support.select import Select
from selenium.webdriver.support.wait import WebDriverWait

REPO = Path(__file__).resolve().parents[1]
APP = REPO / "target/release/pdf-bucket-desktop"
ORIGIN = f"http://127.0.0.1:{json.loads((REPO / 'pdf-bucket.config.json').read_text())['server']['port']}"
FIXTURES = REPO / "tests/fixtures"
# The runtime files `just provision` installs, taken from the checkout.
RUNTIME = {
    "dist/web": REPO / "dist/web",
    "vendor": REPO / "vendor",
    "plugins/manifests": REPO / "plugins/manifests",
    ".venv": REPO / ".venv",
}
SETTLE = 2.0
# A value a script hands back through WebDriver: JSON.
type Script = str | int | float | bool | None | list[Script] | dict[str, Script]


def headless_display(stack: ExitStack) -> str:
    """Start a headless Weston for the run; return its Wayland socket name."""
    socket = f"pdf-bucket-workflow-{os.getpid()}"
    weston = subprocess.Popen(
        ["weston", "--backend=headless", "--shell=kiosk", "--renderer=pixman", "--width=1400", "--height=900", f"--socket={socket}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    stack.callback(weston.terminate)
    path = Path(os.environ["XDG_RUNTIME_DIR"]) / socket
    deadline = time.monotonic() + 10
    while not path.exists():
        assert time.monotonic() < deadline, "weston did not open its socket"
        time.sleep(0.1)
    return socket


@pytest.fixture
def data_home(tmp_path: Path) -> Path:
    runtime = tmp_path / "data/pdf-bucket-app"
    for name, source in RUNTIME.items():
        (runtime / name).parent.mkdir(parents=True, exist_ok=True)
        (runtime / name).symlink_to(source)
    (runtime / "extensions").mkdir()
    return tmp_path / "data"


@pytest.fixture
def app(data_home: Path, tmp_path: Path) -> Iterator[webdriver.WebKitGTK]:
    with ExitStack() as stack:
        env = {
            **os.environ,
            "WAYLAND_DISPLAY": headless_display(stack),
            "GDK_BACKEND": "wayland",
            "GSETTINGS_BACKEND": "memory",
            "XDG_DATA_HOME": str(data_home),
            "XDG_CACHE_HOME": str(tmp_path / "cache"),
            "TAURI_WEBVIEW_AUTOMATION": "true",
        }
        options = webdriver.WebKitGTKOptions()
        options.binary_location = str(APP)
        options.set_capability("browserName", "wry")
        service = webdriver.WebKitGTKService(executable_path="/usr/bin/WebKitWebDriver", env=env)
        driver = webdriver.WebKitGTK(options=options, service=service)
        stack.callback(driver.quit)
        WebDriverWait(driver, 60).until(lambda d: d.current_url.startswith(ORIGIN))
        yield driver


def capture(fixture: str) -> str:
    """Capture a fixture PDF as the browser extension does; return its key."""
    output = subprocess.run(
        [
            "curl",
            "--fail-with-body",
            "--silent",
            "--show-error",
            "-F",
            f"pdf=@{FIXTURES / fixture};filename={fixture};type=application/pdf",
            "-F",
            f"pdf_url=https://www.math.example.edu/~author/{fixture}",
            "-F",
            f"title_hint={fixture}",
            f"{ORIGIN}/capture-bytes",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    key = json.loads(output)["key"]
    assert isinstance(key, str), output
    return key


class Reader:
    """The reader tab of one item: the reader page's window, and the PDF.js viewer framed in it."""

    def __init__(self, driver: webdriver.WebKitGTK, key: str) -> None:
        self.driver = driver
        self.key = key
        self.page = f"document.querySelector(\"iframe[data-reader-key='{key}']\").contentWindow"
        self.viewer = f"{self.page}.document.querySelector('iframe').contentWindow"

    def run(self, script: str) -> Script:
        result: Script = self.driver.execute_script(f"const R = {self.page}, V = {self.viewer};\n{script}")
        return result

    def number(self, expression: str) -> float:
        value = self.run(f"return {expression}")
        assert isinstance(value, int | float), value
        return value

    def text(self, expression: str) -> str:
        value = self.run(f"return {expression}")
        assert isinstance(value, str), value
        return value

    def items(self, expression: str) -> list[Script]:
        value = self.run(f"return {expression}")
        assert isinstance(value, list), value
        return value

    def wait(self, condition: str, timeout: float = 30) -> None:
        WebDriverWait(self.driver, timeout).until(
            lambda d: d.execute_script(f"try {{ const R = {self.page}, V = {self.viewer}; return Boolean({condition}) }} catch (e) {{ return false }}")
        )

    def loaded(self) -> None:
        """Wait until the PDF is shown with its text and the editors are on, then record the
        reader's saves and the viewer's script errors from here on."""
        self.wait("V.document.querySelector('.textLayer span') !== null && V.PDFViewerApplication.pdfViewer.annotationEditorMode !== V.pdfjsLib.AnnotationEditorType.DISABLE")
        self.run("""
          R.__saves = []; V.__errors = [];
          const fetch = R.fetch;
          R.fetch = async (...args) => {
            const response = await fetch(...args);
            if (args[1]?.method === 'PUT') R.__saves.push(response.status);
            return response;
          };
          V.addEventListener('error', (e) => V.__errors.push(String(e.message)));
          V.addEventListener('unhandledrejection', (e) => V.__errors.push(String(e.reason)));
        """)

    def page_number(self) -> int:
        return int(self.number("V.PDFViewerApplication.page"))

    def box(self, selector: str) -> tuple[float, float, float, float]:
        """The first SELECTOR element's box in the viewer, in the window's coordinates."""
        x, y, w, h = self.items(f"""(() => {{
          const box = V.document.querySelector({json.dumps(selector)}).getBoundingClientRect();
          let x = box.x, y = box.y;
          for (let w = V; w !== window; w = w.parent) {{
            const frame = w.frameElement.getBoundingClientRect();
            x += frame.x; y += frame.y;
          }}
          return [x, y, box.width, box.height] }})()""")
        assert isinstance(x, int | float) and isinstance(y, int | float)
        assert isinstance(w, int | float) and isinstance(h, int | float)
        return x, y, w, h

    def click(self, selector: str) -> None:
        x, y, w, h = self.box(selector)
        actions = ActionChains(self.driver)
        actions.w3c_actions.pointer_action.move_to_location(int(x + w / 2), int(y + h / 2)).click()
        actions.perform()

    def click_header(self, button: str) -> None:
        """Click a button in the reader's own header, above the viewer."""
        box = f"R.document.getElementById('{button}').getBoundingClientRect()"
        x = self.number(f"R.frameElement.getBoundingClientRect().x + {box}.x")
        y = self.number(f"R.frameElement.getBoundingClientRect().y + {box}.y")
        w, h = self.number(f"{box}.width"), self.number(f"{box}.height")
        actions = ActionChains(self.driver)
        actions.w3c_actions.pointer_action.move_to_location(int(x + w / 2), int(y + h / 2)).click()
        actions.perform()

    def drag_across(self, page: int) -> None:
        """Press on the first text of PAGE and drag down and to the right across three lines."""
        x, y, w, h = self.box(f'.page[data-page-number="{page}"] .textLayer span[role="presentation"]')
        actions = ActionChains(self.driver)
        pointer = actions.w3c_actions.pointer_action
        pointer.move_to_location(int(x + 2), int(y + h / 2)).pointer_down()
        for step in range(1, 11):
            pointer.move_to_location(int(x + 2 + w / 2 * step / 10), int(y + h / 2 + 3 * h * step / 10))
        pointer.pointer_up()
        actions.perform()

    def page_down(self) -> None:
        """Press Page Down and wait for the scroll it starts. WebKitWebDriver's wheel actions
        scroll from where the first one began, so reading scrolls with the keyboard."""
        top = self.number("V.document.getElementById('viewerContainer').scrollTop")
        ActionChains(self.driver).send_keys(Keys.PAGE_DOWN).perform()
        self.wait(f"V.document.getElementById('viewerContainer').scrollTop > {top}")
        time.sleep(0.5)

    def selection(self) -> str:
        return self.text("V.getSelection().toString()")

    def highlights(self) -> int:
        return int(self.number("V.document.querySelectorAll('.highlightEditor').length"))

    def assert_saved(self) -> None:
        """Every save since the PDF loaded was taken, and the conflict bar is hidden."""
        saves = self.items("R.__saves")
        assert saves and set(saves) == {200}, saves
        assert self.run("return R.document.getElementById('conflict').hidden")

    def errors(self) -> list[Script]:
        return self.items("V.__errors")

    def highlight(self, page: int) -> None:
        """Draw a highlight with the toolbar's highlight tool over PAGE's first lines; wait for its save."""
        saved = self.number("R.__saves.length")
        before = self.highlights()
        self.click("#editorHighlightButton")
        self.wait("V.PDFViewerApplication.pdfViewer.annotationEditorMode === V.pdfjsLib.AnnotationEditorType.HIGHLIGHT")
        self.drag_across(page)
        self.wait(f"V.document.querySelectorAll('.highlightEditor').length > {before}")
        self.wait(f"R.__saves.length > {saved}")
        time.sleep(SETTLE)
        self.click("#editorHighlightButton")


def open_from_library(driver: webdriver.WebKitGTK, key: str) -> Reader:
    show_library(driver)
    row = f"//tbody/tr[@data-item-id={json.dumps(key)}]/td[@data-column='title']"
    cell = WebDriverWait(driver, 30).until(lambda d: d.find_element(By.XPATH, row))
    ActionChains(driver).double_click(cell).perform()
    reader = Reader(driver, key)
    WebDriverWait(driver, 30).until(lambda d: d.find_elements(By.CSS_SELECTOR, f"[data-tab-key='{key}'][data-state='active']"))
    reader.loaded()
    return reader


def show_library(driver: webdriver.WebKitGTK) -> None:
    driver.find_element(By.XPATH, "//button[@role='tab'][normalize-space()='Library']").click()
    WebDriverWait(driver, 30).until(lambda d: d.find_elements(By.CSS_SELECTOR, "nav[aria-label='Library']"))


def nav_to(driver: webdriver.WebKitGTK, label: str) -> None:
    driver.find_element(By.XPATH, f"//nav[@aria-label='Library']//a[contains(normalize-space(), '{label}')]").click()


def show_tab(driver: webdriver.WebKitGTK, key: str) -> None:
    driver.find_element(By.CSS_SELECTOR, f"[data-tab-key='{key}'] [role='tab']").click()
    WebDriverWait(driver, 30).until(lambda d: d.find_elements(By.CSS_SELECTOR, f"[data-tab-key='{key}'][data-state='active']"))


def close_tab(driver: webdriver.WebKitGTK, key: str) -> None:
    driver.find_element(By.CSS_SELECTOR, f"[data-tab-key='{key}'] button[aria-label^='Close']").click()
    WebDriverWait(driver, 30).until(lambda d: not d.find_elements(By.CSS_SELECTOR, f"iframe[data-reader-key='{key}']"))


def replace_text(field: WebElement, text: str) -> None:
    field.click()
    field.send_keys(Keys.CONTROL, "a")
    field.send_keys(Keys.DELETE)
    field.send_keys(text)


def stored_pdf(data_home: Path, key: str) -> pikepdf.Pdf:
    return pikepdf.open(data_home / "pdf-bucket" / f"{key}.pdf")


def highlights_in(pdf: pikepdf.Pdf) -> int:
    return sum(1 for page in pdf.pages for annotation in page.get("/Annots", []) if annotation.get("/Subtype") == "/Highlight")


def test_a_reading_session(app: webdriver.WebKitGTK, data_home: Path) -> None:
    notes = capture("outlined-notes.pdf")
    problems = capture("ten-page-notes.pdf")
    for key in (notes, problems):
        if app.find_elements(By.CSS_SELECTOR, f"[data-tab-key='{key}']"):
            close_tab(app, key)

    # Open the notes from the library and read: scroll down past the first page.
    reader = open_from_library(app, notes)
    assert reader.page_number() == 1
    reader.click('.page[data-page-number="1"]')
    while reader.page_number() < 3:
        reader.page_down()

    # Select a passage with a plain drag; the selection stays.
    page = reader.page_number()
    reader.drag_across(page)
    selected = reader.selection()
    assert selected.strip()
    time.sleep(SETTLE)
    assert reader.selection() == selected

    # Highlight it.
    reader.highlight(page)
    reader.assert_saved()

    # Jump to a section from the outline, go back, then type a page number.
    reader.click("#viewsManagerToggleButton")
    reader.click("#viewsManagerSelectorButton")
    reader.click("#outlinesViewMenu")
    reader.wait("V.document.querySelector('#outlinesView .treeItem a')?.getBoundingClientRect().width > 0")
    reader.click("#outlinesView .treeItem:nth-child(6) a")
    reader.wait(f"V.PDFViewerApplication.page !== {page}")
    assert reader.page_number() != page
    reader.click_header("back")
    reader.wait(f"V.PDFViewerApplication.page === {page}")
    page_field = reader.box("#pageNumber")
    actions = ActionChains(app)
    actions.w3c_actions.pointer_action.move_to_location(int(page_field[0] + page_field[2] / 2), int(page_field[1] + page_field[3] / 2)).click()
    actions.perform()
    ActionChains(app).key_down(Keys.CONTROL).send_keys("a").key_up(Keys.CONTROL).send_keys("7", Keys.ENTER).perform()
    reader.wait("V.PDFViewerApplication.page === 7")
    # Read it: a page counts as read after MIN_PAGE_SECONDS (src/contract/library.ts).
    time.sleep(6)

    # Leave for the library and the timeline, then open the problem set and highlight there.
    show_library(app)
    nav_to(app, "Timeline")
    Select(app.find_element(By.CSS_SELECTOR, "select[aria-label='Shortest reading']")).select_by_visible_text("Any page read")
    WebDriverWait(app, 30).until(lambda d: d.find_elements(By.CSS_SELECTOR, f"[data-timeline-key='{notes}']"))
    nav_to(app, "Library")
    other = open_from_library(app, problems)
    other.highlight(1)
    other.assert_saved()

    # Back in the notes, the page and the highlight are where they were.
    show_tab(app, notes)
    assert reader.page_number() == 7
    assert reader.highlights() == 1

    # Correct the notes' metadata in the library's inspector.
    show_library(app)
    app.find_element(By.XPATH, f"//tbody/tr[@data-item-id={json.dumps(notes)}]/td[@data-column='title']").click()
    inspector = app.find_element(By.CSS_SELECTOR, "aside[aria-label='Item details']")
    inspector.find_element(By.CSS_SELECTOR, "button[aria-label='Edit metadata']").click()
    replace_text(inspector.find_element(By.CSS_SELECTOR, "[aria-label='Title']"), "Lectures on Lattices")
    replace_text(inspector.find_element(By.CSS_SELECTOR, "[aria-label='Authors, one per line']"), "J. H. Conway")
    replace_text(inspector.find_element(By.CSS_SELECTOR, "[aria-label='Year']"), "1988")
    inspector.find_element(By.XPATH, ".//button[normalize-space()='Save metadata']").click()
    WebDriverWait(app, 30).until(lambda _: not inspector.find_elements(By.CSS_SELECTOR, "[aria-label='Title']"))

    # The notes' reader opened the PDF before the bucket wrote that metadata into it; a new
    # highlight is saved all the same.
    show_tab(app, notes)
    reader.highlight(7)
    reader.assert_saved()

    # Close the notes and open them again: both highlights and the new title are there.
    errors = reader.errors() + other.errors()
    close_tab(app, notes)
    reader = open_from_library(app, notes)
    reader.wait("V.document.querySelectorAll('.highlightEditor, .annotationLayer .highlightAnnotation').length > 0")
    assert "Lectures on Lattices" in reader.text("R.document.querySelector('h1').textContent")

    assert errors + reader.errors() == []

    with stored_pdf(data_home, notes) as pdf:
        assert highlights_in(pdf) == 2
        assert str(pdf.docinfo["/Title"]) == "Lectures on Lattices"
        assert str(pdf.docinfo["/Author"]) == "J. H. Conway"
    with stored_pdf(data_home, problems) as pdf:
        assert highlights_in(pdf) == 1
