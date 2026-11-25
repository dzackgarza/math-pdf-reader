# Contract: Reader Control and Projection

The tab row and the library reach the per-window reader only through these interfaces.
Under FR-003 they display what the reader reports and hold no document lifecycle.

## `ReaderTabsApi` (`src/web/readerTabs.ts`), used by the library

| Member | Meaning |
| --- | --- |
| `openReader(key, at?)` | Open the PDF in a tab, or show its tab |
| `closeReader(key)` | Close the PDF's tab |
| `libraryShown` | True while the Library tab is shown |
| `setItemMenu`, `setExtractionView` | Menu and extraction hooks; no reader state |

## `ReaderControl` (`src/web/reader/readerHost.ts`), used by `tabs.tsx`

| Member | Meaning |
| --- | --- |
| `open(key, at?)` | Load and open in the manager, or wake |
| `activate(key)` | Make the PDF the shown document |
| `close(key)` | Settle the save, then close; rejects on failure or conflict |
| `discard(key)` | Close without saving |
| `sleep(key)` | Settle, close in the manager, keep a bookmark |
| `retitle(key, title)` | Change the tab title |
| `settleAll()` | Settle every save before quit |

## `ReaderProjection` (reported through `onProjection`)

`{ tabs: TabEntry[], active: string | null }`. `tabs` follows the manager's
`getDocumentOrder()` plus held and sleeping entries. `active` is the shown tab (`host.focus`).

## HTTP used by the reader

| Request | Success | Failure |
| --- | --- | --- |
| `GET /pdf/<key>.pdf` | 200, `ETag`, `X-Pdf-Edition` | 404 |
| `PUT /api/items/<key>/pdf` with `If-Match` | 200, new `ETag` | 412 stale, 428 no tag, 409 provenance, 400 not a PDF |
| `PUT /api/items/<key>/reading` `{page, pages, edition}` | 200 | 400, 404 |
