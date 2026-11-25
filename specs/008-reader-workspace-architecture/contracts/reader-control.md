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

## Library view key

`LibraryViewKeySchema` (`src/contract/library.ts`) is a schema, not a plain constant, so
that the server's reader page gets the session-storage key from the generated contract
and the library page and the reader page cannot use different keys.

## Tab row (`src/web/tabs.tsx`)

- The Library tab is always first and never closes. Each PDF the reader holds has one tab
  after it. Showing a PDF's tab activates that PDF in the one EmbedPDF document manager.
  A sleeping tab holds a bookmark; showing it opens its PDF again where it was. Opening a
  PDF that has a tab shows that tab. Ctrl+Tab and Ctrl+Shift+Tab step through the tabs and
  wrap around.
- A capture opens its PDF in a tab through the server's `open-reader` event
  (`server/src/events.rs`). A `metadata` event with a resolved title retitles the tab.
- The reader mounts when the first PDF opens, after the library has set the page's theme,
  which the viewer starts from. It then stays mounted. Opens asked for before the reader
  gives its control wait for it.
- The Library and the reader fill the same box, and the hidden one is only invisible.
  EmbedPDF lays out its pages from its container's size; under `display: none` the
  container has no size, and a PDF opened while the Library shows stays blank.
- While the Library shows, the window sends `bucket-stylus-mode` with `inactive`: pen
  highlighting in View mode applies only to a visible PDF, so tablet clicks go back to
  WebKit while the reader stays mounted.
- A PDF tab's context menu holds Sleep Tab and Close Tab, then the item's menu, which the
  library gives again at each of its renders. Before the library loads, and after it holds
  no item for the tab, the menu holds the tab's entries alone.
- Closing a tab whose PDF cannot settle asks first, as a browser's `beforeunload` prompt
  does. The dialog names the failure; Close Without Saving drops what the reader could not
  save. A PDF that cannot settle when put to sleep stays awake and is shown with its
  failure.
- The desktop app's tray Quit (`desktop/src-tauri/src/follow-open-events.js`) sends
  `pdf-bucket-quit`. The window hands it `settleAll()`; the app quits once that settles and
  asks first when it rejects.

## Window address (`src/web/windowAddress.ts`), FR-006

- While a PDF's tab shows, the library window's address is that PDF's reader,
  `/read/<key>#page=N`, written with `history.replaceState` at each page change the reader
  reports (`onPage`) and at each tab switch. Before the reader reports a page for the PDF,
  the address is `/read/<key>` with no fragment.
- While the Library shows, the address is `/` with the library's own hash route
  (`#/unfiled`, `#/organization/tags/MMP`).
- The library's router reads its route from `useLibraryLocation`, not from the address.
  While a reader address shows, the route stays the last library route, and a library
  navigation changes only that route. The Library tab then writes it back. A route read from
  `#page=N` would be no library screen, and the library would leave its view.
- The library route is kept in session storage under `LIBRARY_VIEW_KEY`, so the standalone
  reader's Library button returns to the view the library last showed in this window.
