# Traps in the browser suites

Behaviour of the tools the suites drive that makes a test pass or fail for the wrong reason.

- **Puppeteer's `::-p-text(...)` matches an input's value.** Waiting for a URL's text after typing it into a field and pressing Enter can match the field itself, before the server's answer renders the text elsewhere.
  A click measured then lands where the element used to be once the answer shifts the layout.
  Wait for the element the answer adds (for a mirror, its `li a[href=…]`), not for the text.

- **`PDFDocumentProxy.numPages` comes before the page views.** Setting `PDFViewerApplication.page` as soon as `pdfDocument.numPages` is known can throw inside PDF.js (`pageView` undefined).
  Wait for `PDFViewerApplication.pdfViewer.pagesCount` instead.

- **`PDFViewerApplication.pdfHistory` has no `initialized` property.** A wait on it never ends.
  The sidebar's initial state is applied when `viewsManager.isInitialViewSet` is true.
