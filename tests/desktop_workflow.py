"""One reading session in the desktop app, driven through its own window.

The release app (target/release/pdf-bucket-desktop) runs against a scratch data home whose runtime
files are the checkout's, on a headless Weston display, under WebKitWebDriver (Tauri's WebDriver
path on Linux). `just test-desktop` runs it in a private network namespace, so the app can take its
fixed port. pytest collects this file only when it is named on the command line.

Every step goes through the window: pointer drags over the page's text, clicks on the reader's and
the library's controls, typing into the inspector. The reader's state is read by script from
EmbedPDF's plugins, and its controls are found in the viewer's shadow root. The stored PDFs are
checked at the end with pikepdf, not through the app.

`RUNTIME`: The runtime files `just provision` installs, taken from the checkout.

`Script`: A value a script hands back through WebDriver: JSON.

`NOTES_LINE`: The first line of body text on pages 2 to 10 of outlined-notes.pdf, and on page 1 of
ten-page-notes.pdf, as fractions of the page's width and height (pdftotext -bbox).

`BELOW_NOTES_LINE`: The next paragraph's line below NOTES_LINE's line on page 2 of
outlined-notes.pdf ("A change of basis..."), clear of a highlight drawn over that line (pdftotext -bbox).

`PAGE_BOX`: A page of the PDF: EmbedPDF draws each in a white box (its snippet's renderPage).

`HIGHLIGHT`: PdfAnnotationSubtype.HIGHLIGHT
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import ExitStack
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import pikepdf
import pymupdf
import pytest
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.actions.wheel_input import ScrollOrigin
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.support.select import Select
from selenium.webdriver.support.wait import WebDriverWait

REPO = Path(__file__).resolve().parents[1]
APP = REPO / "target/release/pdf-bucket-desktop"
ORIGIN = f"http://127.0.0.1:{json.loads((REPO / 'pdf-bucket.config.json').read_text())['server']['port']}"
FIXTURES = REPO / "tests/fixtures"
RUNTIME = {
    "dist/web": REPO / "dist/web",
    "plugins/manifests": REPO / "plugins/manifests",
    ".venv": REPO / ".venv",
}
SETTLE = 2.0
type Script = str | int | float | bool | None | list[Script] | dict[str, Script]


def headless_display(stack: ExitStack) -> str:
    """Start a headless Weston for the run; return its Wayland socket name."""
    socket = f"pdf-bucket-workflow-{os.getpid()}"
    weston = subprocess.Popen(
        [
            "weston",
            "--backend=headless",
            "--shell=kiosk",
            "--renderer=pixman",
            "--width=1400",
            "--height=900",
            f"--socket={socket}",
        ],
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
    """direnv keeps its `direnv allow` records in the data home; without them the `.envrc` is blocked."""
    runtime = tmp_path / "data/pdf-bucket-app"
    for name, source in RUNTIME.items():
        (runtime / name).parent.mkdir(parents=True, exist_ok=True)
        (runtime / name).symlink_to(source)
    (runtime / "extensions").mkdir()
    user_data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    (tmp_path / "data/direnv").symlink_to(user_data / "direnv")
    return tmp_path / "data"


def open_window(
    stack: ExitStack, data_home: Path, tmp_path: Path
) -> webdriver.WebKitGTK:
    """The app starts as autostart starts it: outside any shell that has loaded the `.envrc`.

    The driver and the app write to the test's output, which pytest shows when the run fails.
    """
    env = {
        **{
            name: value
            for name, value in os.environ.items()
            if not name.startswith("DIRENV_")
        },
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
    service = webdriver.WebKitGTKService(
        executable_path="/usr/bin/WebKitWebDriver",
        env=env,
        log_output=subprocess.STDOUT,
    )
    driver = webdriver.WebKitGTK(options=options, service=service)
    stack.callback(driver.quit)
    return driver


@pytest.fixture
def app(data_home: Path, tmp_path: Path) -> Iterator[webdriver.WebKitGTK]:
    """A start failure replaces the library with a page that names the cause."""
    with ExitStack() as stack:
        driver = open_window(stack, data_home, tmp_path)
        try:
            WebDriverWait(driver, 60).until(lambda d: d.current_url.startswith(ORIGIN))
        except TimeoutException:
            body = driver.find_element(By.TAG_NAME, "body").text
            pytest.fail(f"the window stayed at {driver.current_url}: {body}")
        yield driver


def post_capture(fixture: str) -> dict[str, Script]:
    """Capture a fixture PDF as the browser extension does, from its published URL; return the
    capture response."""
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
    response = json.loads(output)
    assert isinstance(response, dict), output
    return response


def capture(driver: webdriver.WebKitGTK, fixture: str) -> str:
    """Capture a fixture PDF as the browser extension does; return its key after the
    capture's reader event has opened and drawn its PDF."""
    key = post_capture(fixture)["key"]
    assert isinstance(key, str), key
    try:
        WebDriverWait(driver, 30).until(
            lambda d: d.find_elements(
                By.CSS_SELECTOR, f"[data-tab-key='{key}'][data-state='active']"
            )
        )
    except TimeoutException:
        pytest.fail(
            f"The capture of {fixture} as {key} did not show its tab: {window_state(driver)}"
        )
    Reader(driver, key).loaded()
    return key


NOTES_LINE = (134 / 612, 154 / 792)
BELOW_NOTES_LINE = (134 / 612, 197 / 792)
PROBLEMS_LINE = (134 / 595.276, 268 / 841.89)
PAGE_BOX = 'div[style*="transform-origin"][style*="background-color"]'
HIGHLIGHT = 9


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
      // A ResizeObserver loop is reported as an error event that carries no thrown value.
      window.addEventListener('error', (e) => { if (e.error !== null) window.__errors.push(String(e.message)); });
      window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
    """)


def test_wheel_reading_keeps_position(app: webdriver.WebKitGTK, tmp_path: Path) -> None:
    key = capture(app, "arxiv-2609.21174v1.pdf")
    reader = Reader(app, key)
    reader.run("P('zoom').requestZoom('fit-page')")
    time.sleep(1)
    reader.run("P('viewport').scrollTo({x:0,y:100,behavior:'instant'})")
    time.sleep(0.5)
    for delta in [240] * 20 + [-240] * 20:
        before = reader.number("P('viewport').getMetrics().scrollTop")
        actions = ActionChains(app)
        actions.reset_actions()
        actions.scroll_from_origin(
            ScrollOrigin.from_viewport(900, 600), 0, delta
        ).perform()
        reader.wait(f"P('viewport').getMetrics().scrollTop !== {before}")
        time.sleep(0.3)
        after = reader.number("P('viewport').getMetrics().scrollTop")
        assert after == pytest.approx(before + delta, abs=1), reader.state()
    app.save_screenshot(str(tmp_path / "wheel-reading.png"))


class Reader:
    """The reader of one item, and the EmbedPDF viewer in it, whose UI is in its shadow root."""

    def __init__(self, driver: webdriver.WebKitGTK, key: str) -> None:
        self.driver = driver
        self.key = key
        self.reader = f"[data-reader-key={json.dumps(key)}]"
        self.viewer = (
            f"document.querySelector({json.dumps(self.reader + ' embedpdf-container')})"
        )

    def run(self, script: str) -> Script:
        """Run SCRIPT with V the viewer, S its shadow root and P(id) the capability of its plugin ID."""
        result: Script = self.driver.execute_script(
            f"const V = {self.viewer}, S = V?.shadowRoot, P = (id) => V.__registry.getPlugin(id).provides();\n{script}"
        )
        return result

    def state(self) -> Script:
        """What the window holds of this reader: its viewer, EmbedPDF's documents, the page boxes
        and their images, and the page errors."""
        script = f"""const done = arguments[arguments.length - 1], V = {self.viewer}, S = V?.shadowRoot;
          const page = {{
            viewer: V !== null, tab: document.querySelector('[data-tab-key={json.dumps(self.key)}]')?.dataset.state,
            boxes: S ? [...S.querySelectorAll('{PAGE_BOX}')].map((e) => {{ const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }}) : null,
            images: S ? [...S.querySelectorAll('{PAGE_BOX} img')].map((image) => ({{complete: image.complete, width: image.naturalWidth, src: image.src.slice(0, 40)}})) : null,
            errors: window.__errors, pens: window.__pens?.slice(0, 6), moves: window.__moves?.slice(-20), body: document.body.innerText.slice(0, 1000),
          }};
          if (V === null) {{ done(page); return; }}
          page.visibility = document.visibilityState;
          const frame = Promise.race([new Promise((resolve) => requestAnimationFrame(() => resolve('fired'))),
            new Promise((resolve) => setTimeout(() => resolve('none in 1 s'), 1000))]);
          const late = setTimeout(() => done({{...page, registry: 'not ready after 5 s'}}), 5000);
          frame.then((fired) => {{ page.frame = fired; return V.registry; }}).then((R) => {{
            clearTimeout(late);
            const documents = R.getPlugin('document-manager').provides();
            const scroll = R.getPlugin('scroll').provides(), interaction = R.getPlugin('interaction-manager').provides();
            const viewport = R.getPlugin('viewport').provides(), id = documents.getActiveDocumentId();
            done({{...page, active: documents.getActiveDocumentId(), order: documents.getDocumentOrder(),
              window: [window.innerWidth, window.innerHeight], page: scroll.getCurrentPage(), scrolling: scroll.getPageChangeState(),
              viewport: id === null ? null : [
              viewport.forDocument(id).getMetrics(), viewport.getGates(id),
              viewport.forDocument(id).isSmoothScrolling(), viewport.isViewportMounted(id)
            ],
              zoom: id === null ? null : R.getPlugin('zoom').getDocumentState(id),
              spreads: id === null ? null : scroll.forDocument(id).getSpreadPagesWithRotatedSize().length,
              loaded: id === null ? null : R.getStore().getState().core.documents[id]?.status,
              mode: interaction.getActiveMode(), tool: R.getPlugin('annotation').provides().getActiveTool()?.id ?? null,
              selection: id === null ? null : (({{geometry, rects, slices, ...rest}}) =>
              ({{...rest, geometry: Object.keys(geometry)}})
            )(R.getPlugin('selection').getDocumentState(id)),
              annotations: R.getPlugin('annotation').provides().getAnnotations().map(
              (tracked) => [tracked.object.type, tracked.object.pageIndex, tracked.commitState]
            )}});
          }}, (error) => done({{...page, registry: String(error)}}));"""
        result: Script = self.driver.execute_async_script(script)
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
        """Wait until CONDITION holds; past TIMEOUT, fail with the reader's state."""
        try:
            WebDriverWait(self.driver, timeout).until(
                lambda _: self.run(f"return Boolean({condition})")
            )
        except TimeoutException:
            pytest.fail(
                f"{self.key}: {condition} did not hold in {timeout} s; {self.state()}"
            )

    def loaded(self) -> None:
        """Wait until the viewer has activated this PDF, laid it out and drawn a page, then keep
        its plugin registry."""
        self.driver.execute_async_script(
            f"const done = arguments[arguments.length - 1], V = {self.viewer}; "
            "V.registry.then((R) => { V.__registry = R; done(); });"
        )
        self.wait(
            f"P('document-manager').getActiveDocumentId() === {json.dumps(self.key)} "
            f"&& [...S.querySelectorAll('{PAGE_BOX} img')].some((image) => image.complete && image.naturalWidth > 0)"
        )

    def page_number(self) -> int:
        return int(self.number("P('scroll').getCurrentPage()"))

    def page_box(self, page: int) -> tuple[float, float, float, float]:
        """The box of PAGE once it crosses the window's center line. EmbedPDF draws only the
        pages near the one shown, and its page boxes name no page: the boxes drawn are the rendered
        pages in order."""
        box = f"""(() => {{
          const boxes = [...S.querySelectorAll('{PAGE_BOX}')].map((e) => e.getBoundingClientRect()).sort((one, other) => one.y - other.y);
          const pages = [...P('scroll').forDocument({json.dumps(self.key)}).getMetrics().renderedPageIndexes].sort((one, other) => one - other);
          return boxes[pages.indexOf({page - 1})] }})()"""
        self.wait(
            f"(() => {{ const box = {box}; return box !== undefined "
            "&& box.y < innerHeight / 2 && box.bottom > innerHeight / 2 "
            "&& box.x < innerWidth && box.right > 0 })()"
        )
        x, y, w, h = self.items(
            f"(() => {{ const box = {box}; return [box.x, box.y, box.width, box.height] }})()"
        )
        assert isinstance(x, int | float) and isinstance(y, int | float)
        assert isinstance(w, int | float) and isinstance(h, int | float)
        return x, y, w, h

    def click(self, selector: str) -> None:
        """Click the first SELECTOR element in the viewer's shadow root, once EmbedPDF draws it."""
        element = f"S?.querySelector({json.dumps(selector)})"
        self.wait(element)
        self.click_element(element)

    def click_element(self, element: str) -> None:
        """Click the middle of the element the script expression ELEMENT names."""
        x, y, w, h = self.items(
            f"(() => {{ const box = ({element}).getBoundingClientRect(); return [box.x, box.y, box.width, box.height] }})()"
        )
        assert isinstance(x, int | float) and isinstance(y, int | float)
        assert isinstance(w, int | float) and isinstance(h, int | float)
        actions = ActionChains(self.driver)
        actions.w3c_actions.pointer_action.move_to_location(
            int(x + w / 2), int(y + h / 2)
        ).click()
        actions.perform()

    def click_command(self, command: str) -> None:
        """Click the button of the reader's COMMAND in EmbedPDF's toolbar."""
        self.click(f"[data-epdf-i='bucket:{command}'] button")

    def stroke_box(self, page: int) -> tuple[float, float, float, float]:
        """PAGE's box once a stroke on it takes: the page has stopped moving (a toolbar that opens
        moves the pages down), and EmbedPDF has loaded its text geometry, which it loads after the
        page shows and without which a stroke selects and highlights nothing."""
        self.wait(
            f"V.__registry.getPlugin('selection').getDocumentState({json.dumps(self.key)}).geometry[{page - 1}] !== undefined"
        )
        boxes = [self.page_box(page)]
        WebDriverWait(self.driver, 30, poll_frequency=0.2).until(
            lambda _: boxes.append(self.page_box(page)) or boxes[-1] == boxes[-2]
        )
        return boxes[-1]

    def drag_across(self, page: int, line: tuple[float, float]) -> None:
        """Press on LINE of PAGE and drag down and to the right across it into the next."""
        x, y, w, h = self.stroke_box(page)
        start_x, start_y = x + w * line[0], y + h * line[1]
        actions = ActionChains(self.driver)
        pointer = actions.w3c_actions.pointer_action
        pointer.move_to_location(int(start_x), int(start_y)).pointer_down()
        for step in range(1, 11):
            pointer.move_to_location(
                int(start_x + 0.3 * w * step / 10), int(start_y + 0.03 * h * step / 10)
            )
        pointer.pointer_up()
        actions.perform()

    def shows(self, condition: str) -> None:
        """Wait until the page shown, `page`, meets CONDITION, is visible, and the scroll to it
        has ended: the current page changes before a scroll moves the pages."""
        self.wait(
            f"(() => {{ const scroll = P('scroll'), page = scroll.getCurrentPage(); "
            f"return ({condition}) && scroll.getMetrics().visiblePages.includes(page) "
            "&& !scroll.getPageChangeState().isChanging })()"
        )

    def next_page(self) -> None:
        """Go to the next page with the page controls in the toolbar.

        The pages settle at their zoom after they first show. On WebKitGTK 2.52 a smooth scroll
        that starts while the scroll height changes does not move, and EmbedPDF's page change then
        never ends.
        """
        page = self.page_number()
        self.run(
            "if (window.__moves === undefined) { window.__moves = []; const v = P('viewport'), t0 = performance.now(), at = () => Math.round(performance.now() - t0);"
            " v.onViewportResize(({ metrics: m }) => window.__moves.push(['resize', at(), m.scrollTop, m.clientWidth, m.scrollHeight]));"
            " v.onScrollChange(({ scrollMetrics: m }) => window.__moves.push(['scroll', at(), m.scrollTop]));"
            " P('zoom').onZoomChange((e) => window.__moves.push(['zoom', at(), e.newZoom])); } window.__moves = [];"
        )
        heights = [
            self.number(
                f"P('viewport').forDocument({json.dumps(self.key)}).getMetrics().scrollHeight"
            )
        ]
        WebDriverWait(self.driver, 30, poll_frequency=0.3).until(
            lambda _: (
                heights.append(
                    self.number(
                        f"P('viewport').forDocument({json.dumps(self.key)}).getMetrics().scrollHeight"
                    )
                )
                or heights[-1] == heights[-2]
            )
        )
        self.click(
            "[data-epdf-i='bucket-page-controls'] button[aria-label='Next Page']"
        )
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
        return int(
            self.number(
                f"P('annotation').forDocument({json.dumps(self.key)}).getAnnotations()"
                f".filter((tracked) => tracked.object.type === {HIGHLIGHT}).length"
            )
        )

    def saves(self) -> list[Script]:
        """The statuses of the saves of this reader's PDF since `watch`."""
        return self.items(
            f"window.__saves.filter(([url]) => url.endsWith({json.dumps(f'/api/items/{self.key}/pdf')})).map(([, status]) => status)"
        )

    def assert_saved(self) -> None:
        """Every save since `watch` was taken, and the reader shows no conflict or failure."""
        saves = self.saves()
        assert saves and set(saves) == {200}, saves
        assert not self.driver.find_elements(
            By.CSS_SELECTOR, f"{self.reader} [role='alert']"
        )

    def highlight(self, page: int, line: tuple[float, float]) -> None:
        """Draw a highlight with the Annotate toolbar's highlight tool over LINE of PAGE; wait for its
        save.

        The Annotate toolbar opens below the main one and moves the pages down, so the page is
        found once it is open.

        Escape puts the highlighter down: the default tool, which selects text, is in hand.
        """
        saved = len(self.saves())
        before = self.highlights()
        self.click("[data-epdf-i='annotate-mode'] button")
        self.click("[data-epdf-i='add-highlight'] button")
        self.wait("P('annotation').getActiveTool()?.id === 'highlight'")
        self.drag_across(page, line)
        self.wait(
            f"P('annotation').forDocument({json.dumps(self.key)}).getAnnotations()"
            f".filter((tracked) => tracked.object.type === {HIGHLIGHT}).length > {before}"
        )
        self.wait(
            f"window.__saves.filter(([url]) => url.endsWith({json.dumps(f'/api/items/{self.key}/pdf')})).length > {saved}"
        )
        time.sleep(SETTLE)
        ActionChains(self.driver).send_keys(Keys.ESCAPE).perform()
        self.wait(
            "P('interaction-manager').getActiveMode() === P('interaction-manager').getDefaultMode() && P('annotation').getActiveTool() === null"
        )

    def pen_event(self, kind: str, x: float, y: float) -> None:
        """Deliver one PointerEvent of KIND (a pen's pointerdown, pointermove, pointerup or
        pointercancel) at the window's X and Y. The platform delivers a stylus's input as pointer
        events whose pointerType is `pen`, hit-tested to the element under the point as any
        pointer's is: this is that event, dispatched at the element the point lands on, the
        viewer's page interaction surface inside the drawn page box."""
        self.run(
            "(() => {"
            f"const target = S.elementFromPoint({int(x)}, {int(y)});"
            f"target.dispatchEvent(new PointerEvent({json.dumps(kind)}, {{ pointerType: 'pen', pointerId: 5,"
            f"isPrimary: true, bubbles: true, composed: true, buttons: {0 if kind in ('pointerup', 'pointercancel') else 1},"
            f"clientX: {int(x)}, clientY: {int(y)} }}));"
            "})()"
        )

    def pen_press(self, page: int, line: tuple[float, float]) -> tuple[float, float]:
        """Press LINE of PAGE with a stylus; return the window point pressed, for `pen_release`."""
        x, y, w, h = self.stroke_box(page)
        point = (x + w * line[0], y + h * line[1])
        self.pen_event("pointerdown", *point)
        return point

    def pen_release(self, point: tuple[float, float]) -> None:
        """Lift the stylus at POINT, pressed by `pen_press`."""
        self.pen_event("pointerup", *point)

    def shell_pen_event(
        self, kind: str, x: float, y: float, *, tool: Literal["pen", "eraser"] = "pen"
    ) -> None:
        """Send the native bridge's GTK GestureStylus payload through the actual Tauri event
        bus. This tests the injected pen-bridge script, its shadow-DOM hit testing, and the
        reader, rather than spoofing its pointerType. GDK distinguishes the eraser device tool."""
        result = self.driver.execute_async_script(
            """
            const [kind, x, y, eraser, done] = arguments;
            window.__TAURI__.event.emit('stylus-pointer', {kind, x, y, eraser}).then(
                () => done(null), (error) => done(String(error))
            );
            """,
            kind,
            x,
            y,
            tool == "eraser",
        )
        assert result is None, result

    def shell_pen_drag_across(self, page: int, line: tuple[float, float]) -> None:
        """Send a complete stylus stroke as GTK GestureStylus sends it to the Tauri bridge."""
        x, y, w, h = self.stroke_box(page)
        start_x, start_y = x + w * line[0], y + h * line[1]
        self.run(
            "if (window.__pens === undefined) for (const kind of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])"
            " window.addEventListener(kind, (e) => window.__pens.push([e.type, e.pointerType, e.composedPath()[0]?.tagName, e.defaultPrevented]), true);"
            " window.__pens = [];"
        )
        self.shell_pen_event("pointerhover", start_x, start_y)
        self.shell_pen_event("pointerdown", start_x, start_y)
        for step in range(1, 11):
            self.shell_pen_event(
                "pointermove",
                start_x + 0.3 * w * step / 10,
                start_y + 0.03 * h * step / 10,
            )
        self.shell_pen_event("pointerup", start_x + 0.3 * w, start_y + 0.03 * h)

    def pen_drag_across(self, page: int, line: tuple[float, float]) -> None:
        """Draw a stroke with a stylus: press on LINE of PAGE, drag down and to the right across it
        into the next line, and release, as `drag_across` does with the mouse."""
        x, y, w, h = self.stroke_box(page)
        start_x, start_y = x + w * line[0], y + h * line[1]
        self.pen_event("pointerdown", start_x, start_y)
        for step in range(1, 11):
            self.pen_event(
                "pointermove",
                start_x + 0.3 * w * step / 10,
                start_y + 0.03 * h * step / 10,
            )
        self.pen_event("pointerup", start_x + 0.3 * w, start_y + 0.03 * h)

    def highlighted_pixels(
        self,
        page: int,
        counts: Callable[[pymupdf.Pixmap, list[Script]], tuple[int, int]],
    ) -> tuple[int, int]:
        """The window's pixels inside the line boxes of PAGE's highlights, as COUNTS counts them:
        `pixel_counts` in day mode, `night_pixel_counts` in night mode."""
        x, y, _, _ = self.page_box(page)
        boxes = self.items(f"""(() => {{
          const scale = P('zoom').getState().currentZoomLevel, ratio = window.devicePixelRatio;
          return P('annotation').getAnnotations().map((tracked) => tracked.object)
            .filter((object) => object.type === {HIGHLIGHT} && object.pageIndex === {page - 1})
            .flatMap((object) => object.segmentRects)
            .map((r) => [({x} + r.origin.x * scale) * ratio, ({y} + r.origin.y * scale) * ratio, r.size.width * scale * ratio, r.size.height * scale * ratio]) }})()""")
        assert boxes
        return counts(pymupdf.Pixmap(self.driver.get_screenshot_as_png()), boxes)


def pixel_counts(pixmap: pymupdf.Pixmap, boxes: list[Script]) -> tuple[int, int]:
    """The pixels of PIXMAP inside BOXES ([x, y, w, h] each) that are dark, as glyphs are, and that
    are yellow, as a highlight over white paper is."""
    dark = yellow = 0
    for box in boxes:
        assert isinstance(box, list)
        left, top, width, height = (int(value) for value in box)
        for py in range(top + 1, top + height - 1):
            for px in range(left + 1, left + width - 1):
                red, green, blue = pixmap.pixel(px, py)[:3]
                dark += max(red, green, blue) < 140
                yellow += red > 180 and green > 180 and blue < 140
    return dark, yellow


def night_pixel_counts(pixmap: pymupdf.Pixmap, boxes: list[Script]) -> tuple[int, int]:
    """The pixels of PIXMAP inside BOXES that are light, as glyphs are in night mode (a light tan
    over a highlight), and that are a dark warm colour, as the reader's night filter (invert,
    then a half-turn of hue) draws a yellow highlight."""
    light = darkened = 0
    for box in boxes:
        assert isinstance(box, list)
        left, top, width, height = (int(value) for value in box)
        for py in range(top + 1, top + height - 1):
            for px in range(left + 1, left + width - 1):
                red, green, blue = pixmap.pixel(px, py)[:3]
                light += max(red, green, blue) > 150
                darkened += 50 < red < 170 and blue < 60 and red > green > blue
    return light, darkened


def window_state(driver: webdriver.WebKitGTK) -> Script:
    """The window's address, tabs, page errors and text, for a failure message."""
    state: Script = driver.execute_script("""
        return {
            url: location.href,
            tabs: [...document.querySelectorAll('[data-tab-key]')].map((tab) =>
                ({key: tab.dataset.tabKey, state: tab.dataset.state})),
            errors: window.__errors ?? [],
            body: document.body.innerText.slice(0, 3000)
        };
    """)
    return state


def open_from_library(driver: webdriver.WebKitGTK, key: str) -> Reader:
    """The reader's normal Enter shortcut opens the selected item without relying on a
    platform-dependent double-click interval or moving across an inspector overlay.
    """
    show_library(driver)
    row = f"//tbody/tr[@data-item-id={json.dumps(key)}]/td[@data-column='title']"
    cell = WebDriverWait(driver, 30).until(lambda d: d.find_element(By.XPATH, row))
    cell.click()
    ActionChains(driver).send_keys(Keys.ENTER).perform()
    reader = Reader(driver, key)
    try:
        WebDriverWait(driver, 30).until(
            lambda d: d.find_elements(
                By.CSS_SELECTOR, f"[data-tab-key='{key}'][data-state='active']"
            )
        )
    except TimeoutException:
        pytest.fail(
            f"Opening reader {key} did not select its tab: {window_state(driver)}"
        )
    reader.loaded()
    return reader


def show_library(driver: webdriver.WebKitGTK) -> None:
    driver.find_element(
        By.XPATH, "//button[@role='tab'][normalize-space()='Library']"
    ).click()
    WebDriverWait(driver, 30).until(
        lambda d: d.find_elements(By.CSS_SELECTOR, "nav[aria-label='Library']")
    )


def nav_to(driver: webdriver.WebKitGTK, label: str) -> None:
    driver.find_element(
        By.XPATH,
        f"//nav[@aria-label='Library']//a[contains(normalize-space(), '{label}')]",
    ).click()


def show_tab(driver: webdriver.WebKitGTK, key: str) -> None:
    driver.find_element(By.CSS_SELECTOR, f"[data-tab-key='{key}'] [role='tab']").click()
    WebDriverWait(driver, 30).until(
        lambda d: d.find_elements(
            By.CSS_SELECTOR, f"[data-tab-key='{key}'][data-state='active']"
        )
    )


def close_tab(driver: webdriver.WebKitGTK, key: str) -> None:
    driver.find_element(
        By.CSS_SELECTOR, f"[data-tab-key='{key}'] button[aria-label^='Close']"
    ).click()
    WebDriverWait(driver, 30).until(
        lambda d: not d.find_elements(By.CSS_SELECTOR, f"[data-tab-key='{key}']")
    )


def replace_text(field: WebElement, text: str) -> None:
    field.click()
    field.send_keys(Keys.CONTROL, "a")
    field.send_keys(Keys.DELETE)
    field.send_keys(text)


def stored_pdf(data_home: Path, key: str) -> pikepdf.Pdf:
    return pikepdf.open(data_home / "pdf-bucket" / key / f"{key}.pdf")


def highlighted_pixels_in(path: Path) -> tuple[int, int]:
    """The pixels inside the highlights of the PDF at PATH, as MuPDF, a second PDF renderer, draws them
    from their saved appearance, counted as `pixel_counts` does."""
    dark = yellow = 0
    with pymupdf.open(path) as document:
        for page in document:
            for annotation in page.annots(types=[pymupdf.PDF_ANNOT_HIGHLIGHT]):
                pixmap = page.get_pixmap(dpi=144, clip=annotation.rect)
                counted = pixel_counts(pixmap, [[0, 0, pixmap.width, pixmap.height]])
                dark, yellow = dark + counted[0], yellow + counted[1]
    return dark, yellow


def highlights_in(pdf: pikepdf.Pdf) -> int:
    return sum(
        1
        for page in pdf.pages
        for annotation in page.get("/Annots", [])
        if annotation.get("/Subtype") == "/Highlight"
    )


def test_a_reading_session(app: webdriver.WebKitGTK, data_home: Path) -> None:
    """Open the notes from the library and read: go on past the first pages.

    Select a passage with a plain drag; the selection stays.

    Highlight it. The text shows through the highlight.

    In night mode the text still shows through the highlight, light on its darkened colour.

    Jump to a section from the outline, go back, then type a page number. The sidebar holds the
    page thumbnails, then the outline, whose entries are the notes' section titles.

    Read it: a page counts as read after MIN_PAGE_SECONDS (src/contract/library.ts).

    Leave for the library and the timeline, then open the problem set and highlight there.

    Back in the notes, the page and the highlight are where they were.

    Correct the notes' metadata in the library's inspector.

    The notes' reader opened the PDF before the bucket wrote that metadata into it; a new highlight
    is saved all the same.

    Close the notes and open them again: both highlights and the new title are there.

    Another PDF reader draws the saved highlights with the text showing through them too.
    """
    notes = capture(app, "outlined-notes.pdf")
    problems = capture(app, "ten-page-notes.pdf")
    for key in (notes, problems):
        if app.find_elements(By.CSS_SELECTOR, f"[data-tab-key='{key}']"):
            close_tab(app, key)
    watch(app)

    reader = open_from_library(app, notes)
    assert reader.page_number() == 1
    while reader.page_number() < 3:
        reader.next_page()

    page = reader.page_number()
    reader.drag_across(page, NOTES_LINE)
    selected = reader.selection()
    assert selected.strip()
    time.sleep(SETTLE)
    assert reader.selection() == selected

    reader.highlight(page, NOTES_LINE)
    reader.assert_saved()
    dark, yellow = reader.highlighted_pixels(page, pixel_counts)
    assert dark > 0 and yellow > 0, (dark, yellow)
    reader.click_command("night-mode")
    reader.wait(
        "[...S.querySelectorAll('style')].some((sheet) => sheet.textContent.includes('invert(1)'))"
    )
    light, darkened = reader.highlighted_pixels(page, night_pixel_counts)
    assert light > 0 and darkened > 0, (light, darkened)
    reader.click_command("night-mode")

    reader.click("[data-epdf-i='sidebar-button'] button")
    reader.click_element("S.querySelectorAll('[role=tab]')[1]")
    reader.wait(
        "[...S.querySelectorAll('span')].some((entry) => entry.textContent === 'The lattice E8')"
    )
    reader.click_element(
        "[...S.querySelectorAll('span')].find((entry) => entry.textContent === 'The lattice E8')"
    )
    reader.shows(f"page !== {page}")
    reader.click_command("back")
    reader.shows(f"page === {page}")
    reader.click("[data-epdf-i='bucket-page-controls'] input")
    ActionChains(app).key_down(Keys.CONTROL).send_keys("a").key_up(
        Keys.CONTROL
    ).send_keys("7", Keys.ENTER).perform()
    reader.shows("page === 7")
    time.sleep(6)

    show_library(app)
    nav_to(app, "Timeline")
    Select(
        app.find_element(By.CSS_SELECTOR, "select[aria-label='Shortest reading']")
    ).select_by_visible_text("Any page read")
    WebDriverWait(app, 30).until(
        lambda d: d.find_elements(By.CSS_SELECTOR, f"[data-timeline-key='{notes}']")
    )
    nav_to(app, "Library")
    other = open_from_library(app, problems)
    other.highlight(1, PROBLEMS_LINE)
    other.assert_saved()

    show_tab(app, notes)
    reader.shows("page === 7")
    assert reader.highlights() == 1

    show_library(app)
    app.find_element(
        By.XPATH,
        f"//tbody/tr[@data-item-id={json.dumps(notes)}]/td[@data-column='title']",
    ).click()
    inspector = app.find_element(By.CSS_SELECTOR, "aside[aria-label='Item details']")
    inspector.find_element(
        By.CSS_SELECTOR, "button[aria-label='Edit metadata']"
    ).click()
    replace_text(
        inspector.find_element(By.CSS_SELECTOR, "[aria-label='Title']"),
        "Lectures on Lattices",
    )
    replace_text(
        inspector.find_element(By.CSS_SELECTOR, "[aria-label='Authors, one per line']"),
        "J. H. Conway",
    )
    replace_text(inspector.find_element(By.CSS_SELECTOR, "[aria-label='Year']"), "1988")
    inspector.find_element(
        By.XPATH, ".//button[normalize-space()='Save metadata']"
    ).click()
    WebDriverWait(app, 30).until(
        lambda _: not inspector.find_elements(By.CSS_SELECTOR, "[aria-label='Title']")
    )

    show_tab(app, notes)
    reader.highlight(7, NOTES_LINE)
    reader.assert_saved()

    close_tab(app, notes)
    reader = open_from_library(app, notes)
    reader.wait(
        f"P('annotation').forDocument({json.dumps(notes)}).getAnnotations()"
        f".filter((tracked) => tracked.object.type === {HIGHLIGHT}).length > 0"
    )
    assert "Lectures on Lattices" in app.find_element(
        By.CSS_SELECTOR, f"[data-tab-key='{notes}'] [role='tab']"
    ).get_attribute("textContent")

    assert app.execute_script("return window.__errors") == []

    dark, yellow = highlighted_pixels_in(
        data_home / "pdf-bucket" / notes / f"{notes}.pdf"
    )
    assert dark > 0 and yellow > 0, (dark, yellow)
    with stored_pdf(data_home, notes) as pdf:
        assert highlights_in(pdf) == 2
        assert str(pdf.docinfo["/Title"]) == "Lectures on Lattices"
        assert str(pdf.docinfo["/Author"]) == "J. H. Conway"
    with stored_pdf(data_home, problems) as pdf:
        assert highlights_in(pdf) == 1


def test_a_pen_always_highlights(app: webdriver.WebKitGTK, data_home: Path) -> None:
    """View temporarily forces pen highlighting. Annotate leaves the selected annotation tool
    unchanged and delegates the pen stroke to EmbedPDF. Switching back to View restores the
    always-highlight behavior without changing the selected editing tool.

    A pen press, and the pen's release: the highlighter is in hand only while the pen is down, and
    the tool the pen found, the default one (none), is back afterwards.

    A mouse at the same point changes no tool.

    A whole stroke with the pen: press, drag across the line, release. The highlight is made and
    saved, and the tool the pen found is back in hand.

    Annotate is the actual secondary toolbar, not merely the presence of an active tool.

    The highlighter's button takes up the tool and opens no options over the page.

    In Annotate, GTK passes the stylus's native stream through WebKit. Its trusted pointer events
    support EmbedPDF's ink pointer capture; the synthetic View-mode events do not.

    No synthetic stylus events are delivered when Annotate owns the page.

    View closes the secondary toolbar and returns to the default interaction mode.
    """
    notes = capture(app, "outlined-notes.pdf")
    watch(app)
    reader = open_from_library(app, notes)
    while reader.page_number() < 2:
        reader.next_page()
    reader.wait("V.dataset.bucketStylusMode === 'view'")

    point = reader.pen_press(2, NOTES_LINE)
    reader.wait("P('annotation').getActiveTool()?.id === 'highlight'")
    reader.pen_release(point)
    reader.wait("P('annotation').getActiveTool() === null")

    x, y, w, h = reader.page_box(2)
    actions = ActionChains(app)
    actions.w3c_actions.pointer_action.move_to_location(
        int(x + w * NOTES_LINE[0]), int(y + h * NOTES_LINE[1])
    ).click()
    actions.perform()
    assert reader.run("return P('annotation').getActiveTool()") is None

    saved, before = len(reader.saves()), reader.highlights()
    reader.pen_drag_across(2, NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((tracked) => tracked.object.type === {HIGHLIGHT}).length > {before}"
    )
    reader.wait(
        f"window.__saves.filter(([url]) => url.endsWith({json.dumps(f'/api/items/{reader.key}/pdf')})).length > {saved}"
    )
    reader.wait("P('annotation').getActiveTool() === null")

    reader.click("[data-epdf-i='annotate-mode'] button")
    reader.wait("V.dataset.bucketStylusMode === 'edit'")
    reader.wait(
        "P('ui').forDocument(P('document-manager').getActiveDocumentId()).getActiveToolbar('top', 'secondary') === 'annotation-toolbar'"
    )
    controls = "[...S.querySelectorAll('[data-epdf-i]')].filter((e) => e.getClientRects().length > 0).map((e) => e.getAttribute('data-epdf-i')).sort()"
    shown = reader.items(controls)
    reader.click("[data-epdf-i='add-highlight'] button")
    reader.wait("P('annotation').getActiveTool()?.id === 'highlight'")
    assert reader.items(controls) == shown
    point = reader.pen_press(2, NOTES_LINE)
    reader.pen_release(point)
    assert (
        reader.run("return P('annotation').getActiveTool()?.id ?? null") == "highlight"
    )
    ActionChains(app).send_keys(Keys.ESCAPE).perform()
    reader.wait("P('annotation').getActiveTool() === null")

    reader.run("P('annotation').setActiveTool('ink')")
    reader.wait("P('annotation').getActiveTool()?.id === 'ink'")
    before_ink = reader.number(
        "P('annotation').getAnnotations().filter((a) => a.object.type === 15).length"
    )
    before_highlights = reader.highlights()
    reader.drag_across(2, BELOW_NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === 15).length > {before_ink}"
    )
    reader.wait("P('annotation').getActiveTool()?.id === 'ink'")
    assert reader.highlights() == before_highlights

    x, y, w, h = reader.page_box(2)
    point = (x + w * NOTES_LINE[0], y + h * NOTES_LINE[1])
    reader.shell_pen_event("pointerdown", *point)
    reader.shell_pen_event("pointerup", *point)
    assert (
        reader.number(
            "P('annotation').getAnnotations().filter((a) => a.object.type === 15).length"
        )
        == before_ink + 1
    )
    assert reader.highlights() == before_highlights

    reader.click("[data-epdf-i='view-mode'] button")
    reader.wait("V.dataset.bucketStylusMode === 'view'")
    reader.wait(
        "P('ui').forDocument(P('document-manager').getActiveDocumentId()).getActiveToolbar('top', 'secondary') === null"
    )
    reader.next_page()
    reader.pen_drag_across(3, NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length > {before_highlights}"
    )
    assert (
        reader.number(
            "P('annotation').getAnnotations().filter((a) => a.object.type === 15).length"
        )
        == before_ink + 1
    )
    reader.wait("P('annotation').getActiveTool() === null")

    assert reader.highlights() == before + 2
    assert app.execute_script("return window.__errors") == []


def test_gtk_stylus_bridge_preserves_mouse_and_highlights(
    app: webdriver.WebKitGTK, data_home: Path
) -> None:
    """GTK's pen-only gesture event goes through Tauri's IPC and the page's actual bridge, not through
    a fake proximity flag. Mouse drag still selects while the pen is hovering.

    The pen is hovering: ordinary mouse drag selects without activating the highlighter.

    Interrupted stylus contact restores the previous tool, not a stuck highlighter.

    GTK's own pen recognizer sends down/motion/up, which the bridge forwards as pen events.

    Releasing the stylus restores the pointer tool; a subsequent mouse drag selects again.

    A pen can still use ordinary reader controls, even though GTK suppresses its duplicate native
    mouse events: the bridge emits a click on a non-dragged button press/release.

    Native pen clicks must still select a Library table row, whose click handler is on an ancestor
    rather than an explicit button.
    """
    other = capture(app, "ten-page-notes.pdf")
    notes = capture(app, "outlined-notes.pdf")
    watch(app)
    reader = open_from_library(app, notes)
    while reader.page_number() < 2:
        reader.next_page()

    x, y, w, h = reader.page_box(2)
    reader.shell_pen_event("pointerhover", x + w * NOTES_LINE[0], y + h * NOTES_LINE[1])
    reader.drag_across(2, BELOW_NOTES_LINE)
    assert reader.selection().strip()
    assert reader.highlights() == 0
    assert reader.run("return P('annotation').getActiveTool()") is None

    point = (x + w * NOTES_LINE[0], y + h * NOTES_LINE[1])
    reader.shell_pen_event("pointerdown", *point)
    reader.wait("P('annotation').getActiveTool()?.id === 'highlight'")
    reader.shell_pen_event("pointercancel", *point)
    reader.wait("P('annotation').getActiveTool() === null")

    saved, before = len(reader.saves()), reader.highlights()
    reader.shell_pen_drag_across(2, NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((tracked) => tracked.object.type === {HIGHLIGHT}).length > {before}"
    )
    reader.wait(
        f"window.__saves.filter(([url]) => url.endsWith({json.dumps(f'/api/items/{reader.key}/pdf')})).length > {saved}"
    )
    reader.wait("P('annotation').getActiveTool() === null")
    time.sleep(SETTLE)
    assert set(reader.saves()) == {200}
    after_near = len(reader.saves())

    reader.drag_across(2, BELOW_NOTES_LINE)
    assert reader.selection().strip()
    time.sleep(SETTLE)
    assert reader.highlights() == before + 1
    assert len(reader.saves()) == after_near
    assert app.execute_script("return window.__errors") == []

    cx, cy, cw, ch = reader.items("""(() => {
        const b = S.querySelector("[data-epdf-i='bucket-page-controls'] button[aria-label='Next Page']").getBoundingClientRect();
        return [b.x, b.y, b.width, b.height];
    })()""")
    center = (cx + cw / 2, cy + ch / 2)
    reader.shell_pen_event("pointerdown", *center)
    reader.shell_pen_event("pointerup", *center)
    reader.shows("page > 2")

    show_library(app)
    cell = app.find_element(
        By.CSS_SELECTOR, f"tr[data-item-id='{other}'] td[data-column='title']"
    )
    rect = cell.rect
    center = (rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2)
    reader.shell_pen_event("pointerdown", *center)
    reader.shell_pen_event("pointerup", *center)
    WebDriverWait(app, 30).until(
        lambda d: d.find_elements(
            By.CSS_SELECTOR, f"tr[data-item-id='{other}'].bg-accent-soft"
        )
    )


def test_stylus_opens_annotate_and_native_tools_keep_working(
    app: webdriver.WebKitGTK, data_home: Path
) -> None:
    """A pen tap in View opens Annotate. WebKit's native pointer path must then operate the annotation
    toolbar and drawing tools, before a native click returns to View.

    The native editing path is exercised with real WebDriver pointer input because WebKitGTK
    currently maps tablet input to that mouse-compatible path. This does not emulate a physical GDK
    tablet device; its delivery is left to GTK/GDK.

    GDK's View-mode bridge generates pen PointerEvents, including button activation; the Annotate
    button is inside EmbedPDF's shadow DOM.

    WebKit must receive native clicks and a native pointer drag in Annotate. This covers actual
    toolbar interaction, not only programmatic setActiveTool('ink').

    EmbedPDF opens an annotation action menu above a new ink stroke. Start the next stroke
    elsewhere on the same page rather than pressing that floating menu.

    Escape Annotate with the normal browser click pathway and resume the View-only pen highlighter,
    without interference from the earlier pointer-capture strokes.

    An annotation toolbar can activate on pointerdown (rather than click). If a View-mode pen press
    changes the mode before its release, the bridge must still finish its click, otherwise toolbar
    controls intermittently stop responding.
    """
    notes = capture(app, "outlined-notes.pdf")
    watch(app)
    reader = open_from_library(app, notes)
    while reader.page_number() < 2:
        reader.next_page()
    reader.wait("V.dataset.bucketStylusMode === 'view'")

    x, y, w, h = reader.items("""(() => {
      const b = S.querySelector("[data-epdf-i='annotate-mode'] button").getBoundingClientRect();
      return [b.x, b.y, b.width, b.height];
    })()""")
    center = (x + w / 2, y + h / 2)
    reader.shell_pen_event("pointerdown", *center)
    reader.shell_pen_event("pointerup", *center)
    reader.wait("V.dataset.bucketStylusMode === 'edit'")
    reader.wait(
        "P('ui').forDocument(P('document-manager').getActiveDocumentId()).getActiveToolbar('top', 'secondary') === 'annotation-toolbar'"
    )

    reader.click("[data-epdf-i='add-ink'] button")
    reader.wait("P('annotation').getActiveTool()?.id === 'ink'")
    reader.drag_across(2, (0.15, 0.56))
    reader.wait("P('annotation').getAnnotations().some((a) => a.object.type === 15)")
    reader.click("[data-epdf-i='add-ink-highlighter'] button")
    reader.wait("P('annotation').getActiveTool()?.id === 'inkHighlighter'")
    reader.drag_across(2, (0.58, 0.65))
    reader.wait(
        "P('annotation').getAnnotations().filter((a) => a.object.type === 15).length === 2"
    )

    reader.click("[data-epdf-i='view-mode'] button")
    reader.wait("V.dataset.bucketStylusMode === 'view'")
    reader.wait("P('annotation').getActiveTool() === null")
    reader.shell_pen_drag_across(2, NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 1"
    )
    reader.wait("window.__saves.length > 0")
    time.sleep(SETTLE)
    with stored_pdf(data_home, notes) as pdf:
        assert highlights_in(pdf) == 1
        assert (
            sum(
                1
                for page in pdf.pages
                for annotation in page.get("/Annots", [])
                if annotation.get("/Subtype") == "/Ink"
            )
            == 2
        )

    reader.run("""window.__annotatePenClicks = 0;
      S.querySelector("[data-epdf-i='annotate-mode'] button").addEventListener(
        'click', () => { window.__annotatePenClicks += 1; }
      );""")
    reader.shell_pen_event("pointerdown", *center)
    reader.run("""P('ui').forDocument(
      P('document-manager').getActiveDocumentId()
    ).setActiveToolbar('top', 'secondary', 'annotation-toolbar');""")
    reader.wait("V.dataset.bucketStylusMode === 'edit'")
    reader.shell_pen_event("pointerup", *center)
    reader.wait("window.__annotatePenClicks === 1")
    reader.click("[data-epdf-i='view-mode'] button")
    reader.wait("V.dataset.bucketStylusMode === 'view'")
    assert app.execute_script("return window.__errors") == []


def test_annotate_delete_and_backspace_remove_selected_annotations(
    app: webdriver.WebKitGTK, data_home: Path
) -> None:
    """Delete and Backspace remove selected annotations through the reader's keyboard. Editable fields
    retain these keys, and deleting the selection persists to the PDF.

    Select the highlighted text through an actual WebKit pointer click, not a programmatic
    annotation selection, then use a real keyboard Delete press.

    A text-editing field must consume Backspace rather than deleting an annotation.
    """
    notes = capture(app, "outlined-notes.pdf")
    watch(app)
    reader = open_from_library(app, notes)
    while reader.page_number() < 2:
        reader.next_page()
    reader.highlight(2, NOTES_LINE)
    reader.click("[data-epdf-i='add-highlight'] button")
    reader.drag_across(2, BELOW_NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 2"
    )
    ActionChains(app).send_keys(Keys.ESCAPE).perform()
    reader.wait("P('annotation').getActiveTool() === null")
    reader.wait("V.dataset.bucketStylusAnnotation === 'true'")

    ids = reader.items(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).map((a) => a.object.id)"
    )
    assert len(ids) == 2
    rx, ry, rw, rh = reader.items(f"""(() => {{
      const a = P('annotation').getAnnotations().find((a) => a.object.id === {json.dumps(ids[0])});
      const r = a.object.segmentRects[0];
      return [r.origin.x,r.origin.y,r.size.width,r.size.height];
    }})()""")
    x, y, w, h = reader.page_box(2)
    click = ActionChains(app)
    click.w3c_actions.pointer_action.move_to_location(
        int(x + (rx + rw / 2) * w / 612), int(y + (ry + rh / 2) * h / 792)
    ).click()
    click.perform()
    reader.wait(
        f"P('annotation').getSelectedAnnotations().some((a) => a.object.id === {json.dumps(ids[0])})"
    )

    reader.click("[data-epdf-i='bucket-page-controls'] input")
    reader.run(f"P('annotation').selectAnnotation(1, {json.dumps(ids[0])})")
    reader.wait("P('annotation').getSelectedAnnotations().length === 1")
    ActionChains(app).send_keys(Keys.BACKSPACE).perform()
    assert reader.highlights() == 2
    assert reader.run("return P('annotation').getSelectedAnnotations().length") == 1
    reader.run("S.activeElement?.blur()")
    ActionChains(app).send_keys(Keys.DELETE).perform()
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 1"
    )

    last_id = reader.run(
        f"return P('annotation').getAnnotations().find((a) => a.object.type === {HIGHLIGHT}).object.id"
    )
    reader.run(f"P('annotation').selectAnnotation(1, {json.dumps(last_id)})")
    reader.wait("P('annotation').getSelectedAnnotations().length === 1")
    ActionChains(app).send_keys(Keys.BACKSPACE).perform()
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 0"
    )
    reader.wait("window.__saves.length >= 2")
    time.sleep(SETTLE)
    with stored_pdf(data_home, notes) as pdf:
        assert highlights_in(pdf) == 0
    assert app.execute_script("return window.__errors") == []


def test_stylus_eraser_removes_highlights_it_crosses(
    app: webdriver.WebKitGTK, data_home: Path
) -> None:
    """Native eraser reports button 5/buttons 32. A fast stroke deletes a crossed highlight,
    preserving a nearby highlight, the pen's tool, and the stored PDF's remaining highlights.

    Neither a changed zoom nor another active annotation tool can turn the eraser into ink or make
    its hit test use stale page coordinates.

    A stroke well outside either highlighted paragraph must leave both untouched.

    Use the highlight's own text segment geometry. Only the end points of this fast stroke are
    *outside* the highlight; the segment between them must still erase it.

    Zoom changes the scroll position as well as the size of a page. Re-read its rendered
    coordinates *after* the zoom/layout settles; the earlier page_box is stale if EmbedPDF
    repositions the viewport while the first eraser stroke is being delivered.

    Turning the stylus back over draws a fresh highlight, not an eraser stroke.

    In Annotate, ordinary pen input still draws with the selected tool, but the flipped eraser
    deletes annotations it crosses instead of drawing more ink.

    The eraser must also remove an actual ink stroke, not merely a text-markup annotation.

    The eraser must delete this text markup in Annotate without altering the active pen tool.
    """
    notes = capture(app, "outlined-notes.pdf")
    watch(app)
    reader = open_from_library(app, notes)
    while reader.page_number() < 2:
        reader.next_page()

    reader.shell_pen_drag_across(2, NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 1"
    )
    reader.shell_pen_drag_across(2, BELOW_NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 2"
    )
    reader.wait("P('annotation').getActiveTool() === null")
    reader.wait(
        f"window.__saves.some(([url]) => url.endsWith({json.dumps(f'/api/items/{reader.key}/pdf')}))"
    )
    time.sleep(SETTLE)
    with stored_pdf(data_home, notes) as pdf:
        assert highlights_in(pdf) == 2
    before = len(reader.saves())

    reader.run("P('zoom').requestZoom(1.25)")
    reader.wait("Math.abs(P('zoom').getState().currentZoomLevel - 1.25) < 0.01")
    reader.wait("!P('scroll').getPageChangeState().isChanging")
    reader.run("P('annotation').setActiveTool('ink')")
    reader.wait("P('annotation').getActiveTool()?.id === 'ink'")
    x, y, w, h = reader.page_box(2)
    blank = (x + w * 0.05, y + h * 0.05)
    reader.shell_pen_event("pointerhover", *blank, tool="eraser")
    reader.shell_pen_event("pointerdown", *blank, tool="eraser")
    reader.shell_pen_event("pointermove", x + w * 0.8, blank[1], tool="eraser")
    reader.shell_pen_event("pointerup", x + w * 0.8, blank[1], tool="eraser")
    assert reader.highlights() == 2

    rects = reader.items(f"""(() => {{
        const a = P('annotation').getAnnotations().filter((t) => t.object.type === {HIGHLIGHT})
            .map((t) => t.object.segmentRects[0]);
        return a.map((r) => [r.origin.x, r.origin.y, r.size.width, r.size.height])
            .sort((a, b) => a[1] - b[1]);
    }})()""")
    first = rects[0]
    assert isinstance(first, list)
    rx, ry, rw, rh = first
    x, y, w, h = reader.page_box(2)
    start = (x + w * (rx / 612 - 0.06), y + h * ((ry + rh / 2) / 792))
    end = (x + w * ((rx + rw) / 612 + 0.06), start[1])
    reader.shell_pen_event("pointerdown", *start, tool="eraser")
    reader.shell_pen_event("pointermove", *end, tool="eraser")
    reader.shell_pen_event("pointerup", *end, tool="eraser")
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 1"
    )
    assert reader.run("return P('annotation').getActiveTool()?.id") == "ink"
    assert (
        reader.run(
            "return P('annotation').getAnnotations().filter((a) => a.object.type === 15).length"
        )
        == 0
    )
    reader.wait(
        f"window.__saves.filter(([url]) => url.endsWith({json.dumps(f'/api/items/{reader.key}/pdf')})).length > {before}"
    )
    time.sleep(SETTLE)
    assert reader.highlights() == 1
    assert app.execute_script("return window.__errors") == []
    with stored_pdf(data_home, notes) as pdf:
        assert highlights_in(pdf) == 1

    reader.shell_pen_drag_across(2, NOTES_LINE)
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === 2"
    )
    assert reader.run("return P('annotation').getActiveTool()?.id") == "ink"

    reader.click("[data-epdf-i='annotate-mode'] button")
    reader.wait("V.dataset.bucketStylusMode === 'edit'")
    reader.run("P('annotation').setActiveTool('ink')")
    reader.wait("P('annotation').getActiveTool()?.id === 'ink'")
    before_ink = reader.number(
        "P('annotation').getAnnotations().filter((a) => a.object.type === 15).length"
    )
    before_highlights = reader.highlights()
    reader.drag_across(2, (0.15, 0.55))
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === 15).length > {before_ink}"
    )
    assert reader.highlights() == before_highlights
    reader.wait("P('annotation').getActiveTool()?.id === 'ink'")

    ink_points = reader.items("""(() => {
      const ink = P('annotation').getAnnotations().find((a) => a.object.type === 15).object;
      return ink.inkList[0].points.map(({x, y}) => [x, y]);
    })()""")
    assert len(ink_points) > 1
    x, y, w, h = reader.page_box(2)
    point = ink_points[len(ink_points) // 2]
    mid = (x + w * point[0] / 612, y + h * point[1] / 792)
    reader.shell_pen_event("pointerdown", *mid, tool="eraser")
    reader.shell_pen_event("pointerup", *mid, tool="eraser")
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === 15).length === {before_ink}"
    )
    assert reader.highlights() == before_highlights
    assert reader.run("return P('annotation').getActiveTool()?.id") == "ink"

    x, y, w, h = reader.page_box(2)
    start = (x + w * NOTES_LINE[0], y + h * NOTES_LINE[1])
    reader.shell_pen_event("pointerdown", *start, tool="eraser")
    reader.shell_pen_event("pointermove", start[0] + w * 0.15, start[1], tool="eraser")
    reader.shell_pen_event("pointerup", start[0] + w * 0.15, start[1], tool="eraser")
    reader.wait(
        f"P('annotation').getAnnotations().filter((a) => a.object.type === {HIGHLIGHT}).length === {before_highlights - 1}"
    )
    assert reader.run("return P('annotation').getActiveTool()?.id") == "ink"
    assert (
        reader.number(
            "P('annotation').getAnnotations().filter((a) => a.object.type === 15).length"
        )
        == before_ink
    )


FLOATING = """(() => {
  const shown = (element) => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0; };
  const floating = [...S.querySelectorAll('[role=tooltip], [role=menu], [role=dialog], [role=listbox]')]
    .concat([...S.querySelectorAll('[role=menuitem]')].map((item) => item.parentElement))
    .filter((element, index, all) => element !== null && all.indexOf(element) === index && shown(element))
    .map((element) => (element.getAttribute('role') ?? element.tagName) + ': ' + element.textContent.trim().slice(0, 80));
  const ui = V.__registry.getStore().getState().plugins.ui.documents[KEY];
  const menus = Object.keys(ui?.openMenus ?? {});
  const sidebars = Object.values(ui?.activeSidebars ?? {}).filter((sidebar) => sidebar.isOpen).map((sidebar) => sidebar.sidebarId);
  const modal = ui?.activeModal ?? null;
  return { floating, menus, sidebars, modal };
})()"""


def test_one_press_on_the_highlight_tool_takes_the_highlighter_and_opens_nothing(
    app: webdriver.WebKitGTK, tmp_path: Path
) -> None:
    """One press on the Annotate toolbar's highlight button puts the highlighter in hand, and
    no tool options, menu or panel opens over the page."""
    notes = capture(app, "outlined-notes.pdf")
    reader = open_from_library(app, notes)
    floating = FLOATING.replace("KEY", json.dumps(notes))
    reader.click("[data-epdf-i='annotate-mode'] button")
    reader.wait("S?.querySelector(\"[data-epdf-i='add-highlight'] button\")")
    time.sleep(SETTLE)
    before = reader.run(f"return {floating}")
    reader.click("[data-epdf-i='add-highlight'] button")
    time.sleep(SETTLE)
    app.save_screenshot(str(tmp_path / "one-press-highlight.png"))
    after = reader.run(f"return {floating}")
    tool = reader.run("return P('annotation').getActiveTool()?.id ?? null")
    assert {"tool": tool, "open": after} == {"tool": "highlight", "open": before}, (
        tmp_path / "one-press-highlight.png"
    )


def test_keys_reach_the_reader_opened_from_the_library_before_any_click_in_it(
    app: webdriver.WebKitGTK,
) -> None:
    """A reader opened from the library with the keyboard takes PageDown and Ctrl+= at once:
    the page moves on and the zoom grows, with no click in the reader first."""
    notes = capture(app, "outlined-notes.pdf")
    close_tab(app, notes)
    reader = open_from_library(app, notes)
    reader.shows("page === 1")
    zoom = reader.number(
        f"P('zoom').forDocument({json.dumps(notes)}).getState().currentZoomLevel"
    )
    top = reader.number(
        f"P('viewport').forDocument({json.dumps(notes)}).getMetrics().scrollTop"
    )
    ActionChains(app).send_keys(Keys.PAGE_DOWN).perform()
    reader.wait(
        f"P('viewport').forDocument({json.dumps(notes)}).getMetrics().scrollTop > {top}",
        timeout=10,
    )
    ActionChains(app).key_down(Keys.CONTROL).send_keys("=").key_up(
        Keys.CONTROL
    ).perform()
    reader.wait(
        f"P('zoom').forDocument({json.dumps(notes)}).getState().currentZoomLevel > {zoom}",
        timeout=10,
    )


def test_a_port_already_taken_shows_math_pdf_reader_is_not_serving_in_its_window(
    data_home: Path, tmp_path: Path
) -> None:
    """The window names Math PDF Reader, and a start failure names it too."""
    with (
        socket.create_server(("127.0.0.1", int(ORIGIN.rsplit(":", 1)[1]))),
        ExitStack() as stack,
    ):
        driver = open_window(stack, data_home, tmp_path)
        WebDriverWait(driver, 60).until(
            lambda d: d.execute_script(
                "return !document.getElementById('failure').hidden"
            )
        )

        assert driver.title == "Math PDF Reader"
        assert driver.find_element(By.CSS_SELECTOR, "#failure h1").text == (
            "Math PDF Reader is not serving"
        )
        assert driver.find_element(By.ID, "report").text.startswith(
            f"Math PDF Reader could not serve {ORIGIN}: "
        )
        assert (
            driver.execute_async_script(
                "window.__TAURI__.window.getCurrentWindow().title().then(arguments[0])"
            )
            == "Math PDF Reader"
        )


def bus(*arguments: str) -> str:
    """busctl on the session bus the test gives the app (dbus-run-session's); fails with its
    output and the bus address when it exits non-zero."""
    run = subprocess.run(
        ["busctl", "--user", *arguments], capture_output=True, text=True, check=False
    )
    if run.returncode != 0:
        pytest.fail(
            f"busctl {' '.join(arguments)} on {os.environ.get('DBUS_SESSION_BUS_ADDRESS')} "
            f"exited {run.returncode}: {run.stdout}{run.stderr}"
        )
    return run.stdout


def menu_items(layout: Script) -> list[tuple[int, str]]:
    """The ids and labels of the items under a com.canonical.dbusmenu layout `(ia{sv}av)`, depth
    first.

    The layout's root is not an item: it carries libdbusmenu's placeholder label "Label Empty",
    which no tray host shows. A separator has no label.
    """
    assert isinstance(layout, list)
    children = layout[2]
    assert isinstance(children, list)
    items: list[tuple[int, str]] = []
    for child in children:
        assert isinstance(child, dict)
        item = child["data"]
        assert isinstance(item, list) and isinstance(item[0], int)
        assert isinstance(item[1], dict)
        label = item[1].get("label", {})
        assert isinstance(label, dict)
        if isinstance(label.get("data"), str):
            items.append((item[0], label["data"]))
        items += menu_items(item)
    return items


def tray() -> tuple[str, str, str, list[tuple[int, str]]]:
    """The app's StatusNotifierItem as a tray host finds it: its connection, its Title, its menu's
    object path and the menu's items.

    libappindicator exports the item under /org/ayatana/NotificationItem/ on one of the app's
    connections; the others time out or have no introspection, so only that one is read.
    """
    entries = json.loads(bus("--json=short", "list"))
    found = [
        (entry["name"], path)
        for entry in entries
        if entry["name"].startswith(":")
        and (entry.get("process") or "").startswith("pdf-bucket-des")
        for path in subprocess.run(
            ["busctl", "--user", "--list", "tree", entry["name"]],
            capture_output=True,
            text=True,
            check=False,
            timeout=40,
        ).stdout.split()
        if path.startswith("/org/ayatana/NotificationItem/")
        and not path.endswith("/Menu")
    ]
    assert len(found) == 1, found
    name, path = found[0]
    item = "org.kde.StatusNotifierItem"
    title = json.loads(bus("--json=short", "get-property", name, path, item, "Title"))
    menu = json.loads(bus("--json=short", "get-property", name, path, item, "Menu"))
    layout = json.loads(
        bus(
            "--json=short",
            "--",
            "call",
            name,
            menu["data"],
            "com.canonical.dbusmenu",
            "GetLayout",
            "iias",
            "0",
            "-1",
            "1",
            "label",
        )
    )
    return name, title["data"], menu["data"], menu_items(layout["data"][1])


def test_the_tray_item_and_its_menu_name_math_pdf_reader(
    app: webdriver.WebKitGTK,
) -> None:
    """A tray host reads the app's StatusNotifierItem Title and its menu from the session bus."""
    _, title, _, items = tray()

    assert title == "Math PDF Reader"
    assert [label for _, label in items] == [
        "Show Math PDF Reader",
        "Quit Math PDF Reader",
    ]


def accessibility_bus(stack: ExitStack) -> str:
    """Start the AT-SPI bus and registry on the test's session bus; return the AT-SPI bus address.

    A desktop session starts the registry through a systemd user unit, which the test's private
    namespace does not have. The session bus also starts the bus launcher itself, by D-Bus
    activation, when `GetAddress` names `org.a11y.Bus`.
    """
    for program in ("/usr/lib/at-spi-bus-launcher", "/usr/lib/at-spi2-registryd"):
        started = subprocess.Popen(
            [program, *(["--launch-immediately"] if "launcher" in program else [])],
            stdout=subprocess.DEVNULL,
        )
        stack.callback(started.terminate)
    address = json.loads(
        bus(
            "--json=short",
            "call",
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.a11y.Bus",
            "GetAddress",
        )
    )["data"][0]
    assert isinstance(address, str)
    deadline = time.monotonic() + 10
    while (
        "org.a11y.atspi.Registry"
        not in subprocess.run(
            ["busctl", f"--address={address}", "--list", "list"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
    ):
        assert time.monotonic() < deadline, "the AT-SPI registry took no name"
        time.sleep(0.1)
    return address


def accessible(address: str, name: str, path: str, method: str) -> Script:
    """One org.a11y.atspi.Accessible call on the AT-SPI bus."""
    run = subprocess.run(
        [
            "busctl",
            f"--address={address}",
            "--json=short",
            "call",
            name,
            path,
            "org.a11y.atspi.Accessible",
            method,
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    if run.returncode != 0:
        pytest.fail(
            f"{method} on {name} {path} exited {run.returncode}: {run.stdout}{run.stderr}"
        )
    return json.loads(run.stdout)["data"][0]


def accessible_name(address: str, name: str, path: str) -> str:
    """The Name property of an accessible object on the AT-SPI bus."""
    run = subprocess.run(
        [
            "busctl",
            f"--address={address}",
            "--json=short",
            "get-property",
            name,
            path,
            "org.a11y.atspi.Accessible",
            "Name",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    if run.returncode != 0:
        pytest.fail(
            f"Name of {name} {path} exited {run.returncode}: {run.stdout}{run.stderr}"
        )
    value = json.loads(run.stdout)["data"]
    assert isinstance(value, str)
    return value


def toplevels(address: str) -> list[tuple[str, str, list[str]]]:
    """Each application's toplevel windows as AT-SPI reports them: name, role name, and the names
    of the window's descendants."""

    def descendants(name: str, path: str, depth: int) -> list[str]:
        children = accessible(address, name, path, "GetChildren")
        assert isinstance(children, list)
        names: list[str] = []
        for child in children:
            assert isinstance(child, list)
            child_name, child_path = child
            assert isinstance(child_name, str) and isinstance(child_path, str)
            names.append(accessible_name(address, child_name, child_path))
            if depth > 0:
                names += descendants(child_name, child_path, depth - 1)
        return names

    applications = accessible(
        address,
        "org.a11y.atspi.Registry",
        "/org/a11y/atspi/accessible/root",
        "GetChildren",
    )
    assert isinstance(applications, list)
    windows: list[tuple[str, str, list[str]]] = []
    for application in applications:
        assert isinstance(application, list)
        app_name, app_path = application
        assert isinstance(app_name, str) and isinstance(app_path, str)
        children = accessible(address, app_name, app_path, "GetChildren")
        assert isinstance(children, list)
        for window in children:
            assert isinstance(window, list)
            window_name, window_path = window
            assert isinstance(window_name, str) and isinstance(window_path, str)
            role = accessible(address, window_name, window_path, "GetRoleName")
            assert isinstance(role, str)
            windows.append(
                (
                    accessible_name(address, window_name, window_path),
                    role,
                    descendants(window_name, window_path, 6),
                )
            )
    return windows


def test_a_quit_a_reader_cannot_save_asks_in_a_dialog_titled_math_pdf_reader(
    data_home: Path, tmp_path: Path
) -> None:
    """The tray's Quit, with a reader whose save fails, asks before quitting in a dialog.

    The dialog is a GTK toplevel outside the webview, so it is read the way a screen reader reads
    it: through AT-SPI. The failed save is a `pdf-bucket-quit` listener whose promise rejects,
    as a reader's save that fails hands over.
    """
    with ExitStack() as stack:
        address = accessibility_bus(stack)
        driver = open_window(stack, data_home, tmp_path)
        WebDriverWait(driver, 60).until(lambda d: d.current_url.startswith(ORIGIN))
        driver.execute_script(
            "window.addEventListener('pdf-bucket-quit', (event) =>"
            " event.detail.waitUntil(Promise.reject(new Error('the disk is full'))))"
        )
        name, _, menu, items = tray()
        quit_item = next(
            item for item, label in items if label == "Quit Math PDF Reader"
        )
        bus(
            "--",
            "call",
            name,
            menu,
            "com.canonical.dbusmenu",
            "Event",
            "isvu",
            str(quit_item),
            "clicked",
            "s",
            "",
            "0",
        )

        deadline = time.monotonic() + 20
        windows = toplevels(address)
        while not any(role in ("alert", "dialog") for _, role, _ in windows):
            if time.monotonic() > deadline:
                pytest.fail(f"no dialog on the AT-SPI bus {address}: {windows}")
            time.sleep(0.5)
            windows = toplevels(address)
        dialogs = [window for window in windows if window[1] in ("alert", "dialog")]

        assert len(dialogs) == 1, windows
        title, _, text = dialogs[0]
        assert title == "Math PDF Reader", windows
        assert any(
            "A reader could not save: Error: the disk is full" in line for line in text
        ), windows


def test_a_library_folder_that_cannot_be_made_shows_math_pdf_reader_is_not_serving(
    data_home: Path, tmp_path: Path
) -> None:
    """The library folder is `$XDG_DATA_HOME/pdf-bucket`; a file in its place stops the start."""
    folder = data_home / "pdf-bucket"
    folder.write_text("not a folder")
    with ExitStack() as stack:
        driver = open_window(stack, data_home, tmp_path)
        WebDriverWait(driver, 60).until(
            lambda d: d.execute_script(
                "return !document.getElementById('failure').hidden"
            )
        )

        assert driver.title == "Math PDF Reader"
        assert driver.find_element(By.CSS_SELECTOR, "#failure h1").text == (
            "Math PDF Reader is not serving"
        )
        assert driver.find_element(By.ID, "report").text.startswith(
            f"Math PDF Reader could not make its library folder {folder}: "
        )


def test_a_missing_library_page_shows_math_pdf_reader_is_not_serving_and_names_just_provision(
    data_home: Path, tmp_path: Path
) -> None:
    """The installed app reads its library page from `$XDG_DATA_HOME/pdf-bucket-app/dist/web`,
    which only `just provision` writes; `just build-web` writes the checkout's copy."""
    (data_home / "pdf-bucket-app/dist/web").unlink()
    page = data_home / "pdf-bucket-app/dist/web/index.html"
    with ExitStack() as stack:
        driver = open_window(stack, data_home, tmp_path)
        WebDriverWait(driver, 60).until(
            lambda d: d.execute_script(
                "return !document.getElementById('failure').hidden"
            )
        )

        assert driver.find_element(By.CSS_SELECTOR, "#failure h1").text == (
            "Math PDF Reader is not serving"
        )
        report = driver.find_element(By.ID, "report").text
        assert str(page) in report, report
        assert "`just provision`" in report, report
        assert "bucket" not in report.replace(str(page), "").lower(), report


def test_a_captured_reader_address_draws_its_pdf_in_the_window_and_again_after_reload(
    app: webdriver.WebKitGTK,
) -> None:
    """The capture answers with the local reader address, derived from the key; the published
    URL stays only in the provenance."""
    fixture = "arxiv-2609.21174v1.pdf"
    response = post_capture(fixture)
    key = response["key"]
    assert isinstance(key, str), response
    provenance = response["provenance"]
    assert isinstance(provenance, dict), response
    assert provenance["pdf_url"] == f"https://www.math.example.edu/~author/{fixture}"
    assert response["reader_url"] == f"{ORIGIN}/read/{quote(key, safe='')}", response

    address = f"{ORIGIN}/read/{quote(key, safe='')}"
    viewer = f"[data-reader-key={json.dumps(key)}] embedpdf-container"
    app.get(address)
    WebDriverWait(app, 30).until(lambda d: d.find_elements(By.CSS_SELECTOR, viewer))
    Reader(app, key).loaded()
    app.refresh()
    WebDriverWait(app, 30).until(lambda d: d.find_elements(By.CSS_SELECTOR, viewer))
    Reader(app, key).loaded()

    assert app.current_url.startswith(address)
