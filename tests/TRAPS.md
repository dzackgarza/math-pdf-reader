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
  Move through the desktop workflow with the page controls' Next Page button, waiting for each scroll to end.

- **WebDriver's element text is empty for the reader's title in WebKitGTK.** `WebElement.text` answers `''` for the header's `h1`; read its `textContent` attribute.
