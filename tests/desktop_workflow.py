"""One reading session in the desktop app, driven through its own window.

The release app (target/release/pdf-bucket-desktop) runs against a scratch data home whose
runtime files are the checkout's, on a headless Weston display, under WebKitWebDriver (Tauri's
WebDriver path on Linux). `just test-desktop` runs it in a private network namespace, so the app
can take its fixed port. pytest collects this file only when it is named on the command line.

Every step goes through the window: pointer drags over the page's text, clicks on the reader's
and the library's controls, typing into the inspector. The reader's state is read by script from
EmbedPDF's plugins, and its controls are found in the viewer's shadow root. The stored PDFs are
checked at the end with pikepdf, not through the app.
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
from selenium.common.exceptions import TimeoutException
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
    # direnv keeps its `direnv allow` records in the data home; without them the `.envrc` is blocked.
    user_data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    (tmp_path / "data/direnv").symlink_to(user_data / "direnv")
    return tmp_path / "data"


@pytest.fixture
def app(data_home: Path, tmp_path: Path) -> Iterator[webdriver.WebKitGTK]:
    with ExitStack() as stack:
        # The app starts as autostart starts it: outside any shell that has loaded the `.envrc`.
        env = {
            **{name: value for name, value in os.environ.items() if not name.startswith("DIRENV_")},
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
        # The driver and the app write to the test's output, which pytest shows when the run fails.
        service = webdriver.WebKitGTKService(executable_path="/usr/bin/WebKitWebDriver", env=env, log_output=subprocess.STDOUT)
        driver = webdriver.WebKitGTK(options=options, service=service)
        stack.callback(driver.quit)
        try:
            WebDriverWait(driver, 60).until(lambda d: d.current_url.startswith(ORIGIN))
        except TimeoutException:
            # A start failure replaces the library with a page that names the cause.
            body = driver.find_element(By.TAG_NAME, "body").text
            pytest.fail(f"the window stayed at {driver.current_url}: {body}")
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


# The first line of body text on pages 2 to 10 of outlined-notes.pdf, and on page 1 of
# ten-page-notes.pdf, as fractions of the page's width and height (pdftotext -bbox).
NOTES_LINE = (134 / 612, 154 / 792)
PROBLEMS_LINE = (134 / 595.276, 268 / 841.89)
# A page of the PDF: EmbedPDF draws each in a white box (its snippet's renderPage).
PAGE_BOX = 'div[style*="transform-origin"][style*="background-color"]'
HIGHLIGHT = 9  # PdfAnnotationSubtype.HIGHLIGHT


def watch(driver: webdriver.WebKitGTK) -> None:
    """Record the window's saves of PDFs and its script errors from here on. The readers are in
    the library's own window, so one record holds every reader's."""
    driver.execute_script("""
      window.__saves = []; window.__errors = [];
      const fetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (args[1]?.method === 'PUT' && String(args[0]).endsWith('/pdf')) window.__saves.push([String(args[0]), response.status]);
        return response;
      };
      window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
    """)


class Reader:
    """The reader of one item, and the EmbedPDF viewer in it, whose UI is in its shadow root."""

    def __init__(self, driver: webdriver.WebKitGTK, key: str) -> None:
        self.driver = driver
        self.key = key
        self.reader = f"[data-reader-key={json.dumps(key)}]"
        self.viewer = f"document.querySelector({json.dumps(self.reader + ' embedpdf-container')})"

    def run(self, script: str) -> Script:
        """Run SCRIPT with V the viewer, S its shadow root and P(id) the capability of its plugin ID."""
        result: Script = self.driver.execute_script(f"const V = {self.viewer}, S = V?.shadowRoot, P = (id) => V.__registry.getPlugin(id).provides();\n{script}")
        return result

    def number(self, expression: str) -> float:
        value = self.run(f"return {expression}")
        assert isinstance(value, int | float), value
        return value

    def items(self, expression: str) -> list[Script]:
        value = self.run(f"return {expression}")
        assert isinstance(value, list), value
        return value

    def wait(self, condition: str, timeout: float = 30) -> None:
        WebDriverWait(self.driver, timeout).until(lambda _: self.run(f"return Boolean({condition})"))

    def loaded(self) -> None:
        """Wait until the viewer has drawn a page of the PDF, and keep its plugin registry."""
        self.wait(f"[...(S?.querySelectorAll('{PAGE_BOX} img') ?? [])].some((image) => image.complete && image.naturalWidth > 0)")
        self.driver.execute_async_script(f"const done = arguments[arguments.length - 1], V = {self.viewer}; V.registry.then((R) => {{ V.__registry = R; done(); }});")

    def page_number(self) -> int:
        return int(self.number("P('scroll').getCurrentPage()"))

    def page_box(self, page: int) -> tuple[float, float, float, float]:
        """The box of PAGE in the window. EmbedPDF draws only the pages near the one shown, and
        its page boxes name no page: the boxes drawn are the rendered pages in order."""
        x, y, w, h = self.items(f"""(() => {{
          const boxes = [...S.querySelectorAll('{PAGE_BOX}')].map((e) => e.getBoundingClientRect()).sort((one, other) => one.y - other.y);
          const pages = [...P('scroll').getMetrics().renderedPageIndexes].sort((one, other) => one - other);
          const box = boxes[pages.indexOf({page - 1})];
          return [box.x, box.y, box.width, box.height] }})()""")
        assert isinstance(x, int | float) and isinstance(y, int | float)
        assert isinstance(w, int | float) and isinstance(h, int | float)
        return x, y, w, h

    def click(self, selector: str) -> None:
        """Click the first SELECTOR element in the viewer's shadow root."""
        self.click_element(f"S.querySelector({json.dumps(selector)})")

    def click_element(self, element: str) -> None:
        """Click the middle of the element the script expression ELEMENT names."""
        x, y, w, h = self.items(f"(() => {{ const box = ({element}).getBoundingClientRect(); return [box.x, box.y, box.width, box.height] }})()")
        assert isinstance(x, int | float) and isinstance(y, int | float)
        assert isinstance(w, int | float) and isinstance(h, int | float)
        actions = ActionChains(self.driver)
        actions.w3c_actions.pointer_action.move_to_location(int(x + w / 2), int(y + h / 2)).click()
        actions.perform()

    def click_command(self, command: str) -> None:
        """Click the button of the reader's COMMAND in EmbedPDF's toolbar."""
        self.click(f"[data-epdf-i='bucket:{command}'] button")

    def drag_across(self, page: int, line: tuple[float, float]) -> None:
        """Press on LINE of PAGE and drag down and to the right across it into the next."""
        x, y, w, h = self.page_box(page)
        start_x, start_y = x + w * line[0], y + h * line[1]
        actions = ActionChains(self.driver)
        pointer = actions.w3c_actions.pointer_action
        pointer.move_to_location(int(start_x), int(start_y)).pointer_down()
        for step in range(1, 11):
            pointer.move_to_location(int(start_x + 0.3 * w * step / 10), int(start_y + 0.03 * h * step / 10))
        pointer.pointer_up()
        actions.perform()

    def shows(self, condition: str) -> None:
        """Wait until the page shown, `page`, meets CONDITION and the scroll to it has ended: the
        page shown changes while a scroll moves the pages."""
        self.wait(f"(() => {{ const page = P('scroll').getCurrentPage(); return ({condition}) && !P('scroll').getPageChangeState().isChanging }})()")

    def next_page(self) -> None:
        """Go to the next page with the page controls below the PDF."""
        page = self.page_number()
        self.click("[data-epdf-i='page-controls'] button[aria-label='Next Page']")
        self.shows(f"page > {page}")

    def selection(self) -> str:
        result = self.driver.execute_async_script(f"""
          const done = arguments[arguments.length - 1], V = {self.viewer};
          V.__registry.getPlugin('selection').provides().getSelectedText().toPromise().then(
            (lines) => done(lines.join('\\n')),
            (error) => done({{ error: String(error) }}));""")
        assert isinstance(result, str), result
        return result

    def highlights(self) -> int:
        return int(self.number(f"P('annotation').getAnnotations().filter((tracked) => tracked.object.type === {HIGHLIGHT}).length"))

    def saves(self) -> list[Script]:
        """The statuses of the saves of this reader's PDF since `watch`."""
        return self.items(f"window.__saves.filter(([url]) => url.endsWith({json.dumps(f'/api/items/{self.key}/pdf')})).map(([, status]) => status)")

    def assert_saved(self) -> None:
        """Every save since `watch` was taken, and the reader shows no conflict or failure."""
        saves = self.saves()
        assert saves and set(saves) == {200}, saves
        assert not self.driver.find_elements(By.CSS_SELECTOR, f"{self.reader} [role='alert']")

    def highlight(self, page: int, line: tuple[float, float]) -> None:
        """Draw a highlight with the Annotate toolbar's highlight tool over LINE of PAGE; wait for its save."""
        saved = len(self.saves())
        before = self.highlights()
        self.click("[data-epdf-i='annotate-mode'] button")
        self.click("[data-epdf-i='add-highlight'] button")
        # The Annotate toolbar opens below the main one and moves the pages down, so the page is
        # found once it is open.
        self.drag_across(page, line)
        self.wait(f"P('annotation').getAnnotations().filter((tracked) => tracked.object.type === {HIGHLIGHT}).length > {before}")
        self.wait(f"window.__saves.filter(([url]) => url.endsWith({json.dumps(f'/api/items/{self.key}/pdf')})).length > {saved}")
        time.sleep(SETTLE)
        # Escape puts the highlighter down: the default tool, which selects text, is in hand.
        ActionChains(self.driver).send_keys(Keys.ESCAPE).perform()
        self.wait("P('interaction-manager').getActiveMode() === P('interaction-manager').getDefaultMode() && P('annotation').getActiveTool() === null")


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
    WebDriverWait(driver, 30).until(lambda d: not d.find_elements(By.CSS_SELECTOR, f"[data-reader-key='{key}']"))


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
    watch(app)

    # Open the notes from the library and read: go on past the first pages.
    reader = open_from_library(app, notes)
    assert reader.page_number() == 1
    while reader.page_number() < 3:
        reader.next_page()

    # Select a passage with a plain drag; the selection stays.
    page = reader.page_number()
    reader.drag_across(page, NOTES_LINE)
    selected = reader.selection()
    assert selected.strip()
    time.sleep(SETTLE)
    assert reader.selection() == selected

    # Highlight it.
    reader.highlight(page, NOTES_LINE)
    reader.assert_saved()

    # Jump to a section from the outline, go back, then type a page number. The sidebar holds
    # the page thumbnails, then the outline, whose entries are the notes' section titles.
    reader.click("[data-epdf-i='sidebar-button'] button")
    reader.click_element("S.querySelectorAll('[role=tab]')[1]")
    reader.wait("[...S.querySelectorAll('span')].some((entry) => entry.textContent === 'The lattice E8')")
    reader.click_element("[...S.querySelectorAll('span')].find((entry) => entry.textContent === 'The lattice E8')")
    reader.shows(f"page !== {page}")
    reader.click_command("back")
    reader.shows(f"page === {page}")
    reader.click("[data-epdf-i='page-controls'] input")
    ActionChains(app).key_down(Keys.CONTROL).send_keys("a").key_up(Keys.CONTROL).send_keys("7", Keys.ENTER).perform()
    reader.shows("page === 7")
    # Read it: a page counts as read after MIN_PAGE_SECONDS (src/contract/library.ts).
    time.sleep(6)

    # Leave for the library and the timeline, then open the problem set and highlight there.
    show_library(app)
    nav_to(app, "Timeline")
    Select(app.find_element(By.CSS_SELECTOR, "select[aria-label='Shortest reading']")).select_by_visible_text("Any page read")
    WebDriverWait(app, 30).until(lambda d: d.find_elements(By.CSS_SELECTOR, f"[data-timeline-key='{notes}']"))
    nav_to(app, "Library")
    other = open_from_library(app, problems)
    other.highlight(1, PROBLEMS_LINE)
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
    reader.highlight(7, NOTES_LINE)
    reader.assert_saved()

    # Close the notes and open them again: both highlights and the new title are there.
    close_tab(app, notes)
    reader = open_from_library(app, notes)
    reader.wait(f"P('annotation').getAnnotations().filter((tracked) => tracked.object.type === {HIGHLIGHT}).length > 0")
    assert "Lectures on Lattices" in app.find_element(By.CSS_SELECTOR, f"[data-tab-key='{notes}'] [role='tab']").get_attribute("textContent")

    assert app.execute_script("return window.__errors") == []

    with stored_pdf(data_home, notes) as pdf:
        assert highlights_in(pdf) == 2
        assert str(pdf.docinfo["/Title"]) == "Lectures on Lattices"
        assert str(pdf.docinfo["/Author"]) == "J. H. Conway"
    with stored_pdf(data_home, problems) as pdf:
        assert highlights_in(pdf) == 1
