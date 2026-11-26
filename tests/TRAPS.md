# Traps in the browser suites

Behaviour of the tools the suites use that makes a test pass or fail for the wrong reason.

- **Puppeteer's `::-p-text(...)` matches an input's value.** Waiting for a URL's text after typing it into a field and pressing Enter can match the field itself, before the server's answer renders the text elsewhere.
  A click measured then lands where the element used to be once the answer shifts the layout.
  Wait for the element the answer adds (for a mirror, its `li a[href=…]`), not for the text.

- **Puppeteer's `::-p-text(...)` after a descendant combinator matches the innermost element holding the text.** `[role=alert] ::-p-text(Save my copy over it)` matches the banner's span, not the button; after `>>>` into EmbedPDF's shadow root it can match an `svg` path.
  Name the element: `button::-p-text(…)`, or test the text in the page with `page.evaluate`.

- **`page.waitForNavigation()` also resolves on `history.replaceState` in the main frame.** The reader page rewrites its address (`#page=N`) on every page change, so the wait can end before the Library link leaves the page, and a following `page.goto` is aborted (`net::ERR_ABORTED`). Wait for an element of the page being navigated to (the library's `nav a`).

- **The suites run whatever `target/debug/pdf-bucket` is.** The server bakes in the checkout it serves from (`PDF_BUCKET_CHECKOUT`, set by `server/build.rs`). Building another checkout of this workspace with `CARGO_TARGET_DIR` pointed at this one leaves a binary that serves the other checkout's `dist/web`, and `cargo build` here keeps it, because the compiled crate counts as fresh.
  `cargo clean -p pdf-bucket` before building here.

- **A native open exempts that PDF URL in that tab until the tab closes.** A later capture case that follows the same link in the same tab reaches the browser's viewer, and a wait for the capture page times out.
  Follow a link to another PDF, or use a new tab.

- **Chromium draws no frames for a page behind another.** `browser.newPage()` brings the new page to the front; EmbedPDF in the page behind never draws its PDF, and a wait for a drawn page never ends.
  Call `bringToFront()` on the page under test.

- **Chromium's back/forward cache keeps a left page's connections.** A page kept in the cache keeps its `EventSource` open; after a few navigations the six connections Chromium allows to one origin are taken and the next request waits forever.
  The library's event stream closes on `pagehide` (`src/web/bucketEvents.ts`); any new long-lived connection must too.

- **EmbedPDF draws no page controls for a PDF of one page.** Its page-controls bar renders nothing when the PDF has one page, so a test cannot type a page number there; scroll through the scroll plugin (`getPlugin('scroll').provides().scrollToPage`).

- **EmbedPDF's page boxes name no page, and only the pages near the one shown are drawn.** The boxes drawn, ordered by their top, are the scroll plugin's `getMetrics().renderedPageIndexes` in order.
  `getCurrentPage()` changes while a scroll is still moving the pages: wait for `getPageChangeState().isChanging` to be false before measuring a page.

- **WebKitWebDriver's wheel actions scroll from where the first one began.** A second `scroll_from_origin` of +400 after one of +2000 leaves the viewer at 410, as if the first never happened, so a wait for a later page never ends.
  Call `ActionChains.reset_actions()` before each wheel gesture so WebKit starts it at the current position. Supply `ScrollOrigin.from_viewport(x, y)` inside the PDF; `scroll_by_amount` uses the viewport's top-left corner, irrespective of the pointer location.

- **WebDriver's element text is empty for the reader's title in WebKitGTK.** `WebElement.text` answers `''` for the header's `h1`; read its `textContent` attribute.

- **A synthetic pointer event reaches EmbedPDF's page handlers only when dispatched at the element under the point.** EmbedPDF binds page pointer handling to an interaction provider `div` _inside_ the drawn page box (page-sized, `position:relative`), not to the box itself; an event dispatched on the box bubbles past the provider, so a synthetic pen stroke selected nothing and the highlight count stayed at zero.
  Dispatch at the element the platform would hit-test: `S.elementFromPoint(x, y)` (`Reader.pen_event`).

- **The store trashes PDFs with send2trash, which uses `$XDG_DATA_HOME/Trash` for a file on the home file system.** A suite run with the user's data home would put every PDF a test deletes or sends into the user's own Trash.
  `tests/preload.ts` points `XDG_DATA_HOME` and `XDG_CACHE_HOME` at folders inside the run's scratch folder.

- **Bun's `Bun.spawn` and `Bun.spawnSync` do not see a change to `process.env` unless `env: process.env` is passed.** A child started without it gets the environment the test process started with, so the run's `TMPDIR` does not reach it and its files land outside the scratch folder.
  Pass `env` to every spawn in the preload; `tests/test-scratch.test.ts` fails when a file escapes.

- **Every test file makes its folders with `mkdtempSync(join(tmpdir(), ...))` and removes none of them.** The preload sets `TMPDIR` to one folder per test process (`pdf-bucket-test-run-<pid>-*`), removes it after the last test file, and at start removes the folders of runs whose process is gone.
  Screenshots meant for review go under `SCREENSHOT_ROOT` from the preload, the system temporary folder, so they stay after the run.

# Traps in the capture suite

`tests/capture-e2e.test.ts` drives both built extensions with Puppeteer: Chromium through `--load-extension`, Firefox through WebDriver BiDi `webExtension.install`, against the fixture site and a server over a scratch store.

- **Firefox gives each installed extension a random internal UUID for its `moz-extension://` origin.** The suite pins it with a pref so that it can open the extension's own pages.

- **Chromium prints nothing about a launch that times out waiting for the DevTools endpoint.** The suite copies Chromium's own output into the test log.

- **WebDriver BiDi scripts a `moz-extension` document only when it is privileged, and refuses to screenshot, resize or activate a privileged top-level document.** In Firefox the capture page photographs its own tab through the extension API, at the default viewport only, and the extension API activates tabs in both browsers.

- **Chrome's service worker registers its capture rules asynchronously after install.** A navigation before the rules are in force reaches the browser's own viewer; wait for the rules, then navigate.

- **`URL.origin` is `"null"` for the non-special `chrome-extension:` scheme.** Build the origin from `protocol` and `host`.

- **The server announces every capture, new or existing, on the event stream.** Subscribe before the capture starts; the subscription resolves only once the server has registered it, so an announcement cannot be missed.

- **Firefox reports no navigation events for `moz-extension` documents, and WebDriver BiDi cannot navigate a tab into one.** Poll the document's own location, bounded by the case timeout. To open the toolbar popup as a tab in Firefox, a page script goes to the web-accessible capture page with no PDF URL (it captures nothing), then within the extension's origin. After a tab navigates into a `moz-extension` document, BiDi loses track of it: `isClosed()` stays false after it closes, and the browser refuses to evaluate in it.

- **In Chrome a top-level PDF navigation becomes a download.** The tab stays on the page that holds the link, the browser saves the response to the downloads folder, and the server reads it there; the extension removes the download only once the server answers that it holds the PDF. For a failed capture the background opens a capture page tab. Chrome closes a tab opened only for a download before its page can be attached, so watch the tab count. In Firefox the tab passes through the capture page and keeps the navigation's own response.

- **Chrome's Page for a tab keeps the frame Chromium swapped out for the extension page.** Nothing can be evaluated there even while the tab is open; `isClosed()` reports a closed tab.

- **Firefox refuses synthesized input in privileged documents.** A DOM click flips a checkbox and fires its change event in both browsers.

- **A publisher's "Download PDF" button is a link with the `download` attribute.** It starts a download, not a navigation, and is not intercepted.

- **Chromium replaces an iframe's frame when it commits the capture page; Firefox keeps one frame and reports no URL change into it.** A handle to a frame that still shows the PDF URL detaches in Chromium. Chromium's own PDF viewer adds a nested frame.

- **The capture page is web-accessible, so a web page can frame it with any PDF URL.** Only a frame the extension itself sent there gets its PDF captured.

- **In Chromium 156 and in Chrome for Testing 158.0.8127.88 an unpacked extension that Puppeteer loaded does not come back after `chrome.runtime.reload()`.** Before the reload its service worker answers; after it, no `service_worker` target exists, CDP `Target.getTargets` lists no target of the extension, and its `chrome-extension://<id>/popup.html` fails with `net::ERR_BLOCKED_BY_CLIENT`. With `--vmodule=*extension*=1` Chromium logs no line for the extension at all. This holds for the installed `chrome-mv3` build loaded by `enableExtensions` and by `--load-extension` (with `--disable-features=DisableLoadExtensionCommandLineSwitch`), headless and headful under `xvfb-run`. Chrome for Testing (`bunx @puppeteer/browsers install chrome@stable`), with the build loaded by `enableExtensions`, headless and headful under `xvfb-run`, gives no new `service_worker` target and the same `net::ERR_BLOCKED_BY_CLIENT`, so another Chrome build is no route. So the suite cannot show anything the extension does after it reloads itself: a stale build's self-reload, its replacement text after the reload, and a capture by the replacing build. A wait for the worker's restart times out; that is not a defect in the extension.

- **Chrome stops a service worker whose `fetch()` response takes more than 30 s.** A slow store can hold the server's answer past that; the emptied downloads folder shows that a later worker delivered the capture. A page load or a followed PDF link starts a worker.

- **Invariant 4 counts a GET response as a PDF beyond `application/pdf`.** A generic or missing type on a `.pdf` path, the legacy PDF type, and whitespace before the parameters all count.

- **Firefox keeps its start page in a tab's session history.** A tab opened for a PDF alone still holds one entry before the PDF's.

- **The fixture site sets its session cookie on its pages; its PDFs refuse requests without it.** One native load is one request; an intercepted load adds the capture page's own fetch.

- **`page.goto` leaves without the page's leave prompt.** CDP's `Page.navigate` does not run `beforeunload`, so a reader page with an unsaved note is left at once and the note is lost, which the user's own navigation never allows.
  To test leaving, navigate from the page (`location.href = …` in `page.evaluate`) or click a link. To leave a reader after writing a note, use its Library button, which settles every save.

- **`page.goto` to the same path with only a new fragment does not load the page.** The page stays and only `hashchange` fires, so a test that expects the reader to open again sees the old page and its old status.
  Load `about:blank` first.
