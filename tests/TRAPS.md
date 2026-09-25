# Traps in the browser suites

Behaviour of the tools the suites use that makes a test pass or fail for the wrong reason.

- **Puppeteer's `::-p-text(...)` matches an input's value.** Waiting for a URL's text after typing it into a field and pressing Enter can match the field itself, before the server's answer renders the text elsewhere.
  A click measured then lands where the element used to be once the answer shifts the layout.
  Wait for the element the answer adds (for a mirror, its `li a[href=…]`), not for the text.

- **`PDFDocumentProxy.numPages` comes before the page views.** Setting `PDFViewerApplication.page` as soon as `pdfDocument.numPages` is known can throw inside PDF.js (`pageView` undefined).
  Wait for `PDFViewerApplication.pdfViewer.pagesCount` instead.

- **`PDFViewerApplication.pdfHistory` has no `initialized` property.** A wait on it never ends.
  The sidebar's initial state is applied when `viewsManager.isInitialViewSet` is true.

- **A frame handle taken while a new iframe still holds its initial empty document can detach.** `contentFrame()` on a just-inserted iframe returns the frame of `about:blank`; when the real page replaces it, waits on that handle fail with "frame got detached", and after the test times out Bun kills Chromium, so every later test fails too.
  Wait in the parent document for the framed page's content (the library suite's `pdfLoadedIn`), then take the handle.

- **`page.waitForNavigation()` also resolves on `history.replaceState` in the main frame.** The reader rewrites its address on every view change, so the wait can end before the Library link leaves the page, and a following `page.goto` is aborted (`net::ERR_ABORTED`). Wait for an element of the page being navigated to (the library's `nav a`).

- **The suites run whatever `target/debug/pdf-bucket` is.** The server bakes in the checkout it serves from (`PDF_BUCKET_CHECKOUT`, set by `server/build.rs`). Building another checkout of this workspace with `CARGO_TARGET_DIR` pointed at this one leaves a binary that serves the other checkout's `dist/web`, and `cargo build` here keeps it, because the compiled crate counts as fresh.
  `cargo clean -p pdf-bucket` before building here.
