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
| `saved()` | Every tab in tab order, with its title and position (null while loading or failed) |
| `restore(tabs)` | Hold each saved tab as a sleeping tab at its place, unless the reader holds it already |

Activate shows a PDF the reader holds and wakes it when it sleeps. Close and sleep settle the
PDF first (send its reading session, save every annotation) and reject, leaving it open, when
it cannot settle. Leaving the page while an annotation is not yet saved asks first
(`beforeunload`).

## Reader host (`src/web/reader/readerHost.ts`, `src/web/reader/documents.ts`)

- The host record outlives the reader's renders, and every part of the reader reads and
  writes it: the PDFs held (loading, failed or open), their titles, the bookmarks of the
  sleeping ones, the keys of the open PDFs with the one shown last first (`recent`), the PDF
  asked for last (`focus`, the manager's active one once it is open), the PDFs laid out, and
  the position each open PDF had when it stopped being the active one (`parked`).
- `moving` is true while the reader itself moves a PDF (opening at a position, back,
  forward), which is no jump. EmbedPDF announces a page change synchronously inside
  `scrollToPage`.
- EmbedPDF activates a PDF it opens before it creates that PDF's UI state, which its first
  layout follows; `laidOut` names the PDFs laid out.
- A PDF opens at an exact position (a bookmark), at a page, or at its reading record.
- **Sleep.** EmbedPDF's document manager has no suspend, so a PDF put to sleep settles its
  saves, is closed, and leaves a bookmark: its title, exact position and place among the tabs.
  Waking it opens the stored PDF again at that position and place. Five PDFs stay open in the
  manager (`AWAKE_READERS`); past five, the PDFs shown longest ago sleep, which frees their
  PDFium documents, as Firefox's tab unloader picks the tabs it unloads by the time each was
  last shown (`browser/components/tabbrowser/TabUnloader.sys.mjs`). A PDF that cannot settle
  stays awake and says why when shown; the next activation tries it again.
- When a tab closes, the tab after it takes its place, or the one before when it was last.
  EmbedPDF shows that PDF first when it is open, then closes the other; a sleeping one wakes.
- **Reload.** The stored PDF replaces the user's copy, which opens again where it was. The
  PDF is shown again at once, so no other tab takes its place meanwhile.
- **Annotation commit.** EmbedPDF writes an annotation edit into its document
  asynchronously, and raises the edit's committed event (which schedules the save) before it
  clears `hasPendingChanges`. Once that flag is clear, every edit made so far has scheduled
  its save.
- **Reading input.** The reading session of the PDF shown follows whether it is shown and the
  user's input. Shown again, the reader starts reading its PDF's page; hidden, that stretch
  ends and reports. Any key is reading input while the reader is shown: EmbedPDF's viewer
  holds no focus of its own, so the keys arrive at the document, as its own shortcuts do.
- `PAGE_BOX` is the box EmbedPDF draws a page in, the element a pointer must land on to be
  drawing (the desktop suite's page boxes name the same element); a press on the toolbar or a
  sidebar is not one. `activeToolbar` is the secondary toolbar of the PDF shown as EmbedPDF
  names it: null in View, undefined while no laid-out PDF is shown.

## `ReaderProjection` (reported through `onProjection`)

`{ tabs: TabEntry[], active: string | null }`. `tabs` follows the manager's
`getDocumentOrder()` plus held and sleeping entries. `active` is the shown tab (`host.focus`).

## HTTP used by the reader

| Request | Success | Failure |
| --- | --- | --- |
| `GET /pdf/<key>.pdf` | 200, `ETag`, `X-Pdf-Edition` | 404 |
| `PUT /api/items/<key>/pdf` with `If-Match` | 200, new `ETag` | 412 stale, 428 no tag, 409 provenance, 400 not a PDF |
| `PUT /api/items/<key>/reading` `{page, pages, zoom, edition}` | 200 | 400, 404 |

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

## Reader page (`src/web/reader/main.tsx`)

- `/read/<key>` is one reader filling the window. The server renders the page's head
  (`server/templates/reader.html`) with the Highwire `citation_*` tags the Zotero Connector
  reads. The address's `#page=N` names the page shown, so a reload opens the same page. A
  resolved title from the metadata resolver renames the page and its `citation_title`.
- The page's stylesheet is the library's, which the bundle holds as text: the build names a
  stylesheet that two entries share by its content hash, which the server's page cannot know.

## Window tabs across a reload (`src/web/windowTabs.ts`), FR-009

- When the library page unloads (`pagehide`) after the reader mounted, it keeps its tabs in
  session storage under `WINDOW_TABS_KEY` (`WindowTabsSchema`): each tab in tab order with its
  key, title and position, and the tab shown, or null for the Library.
- The library page takes that record at load and removes it. After a reload of the library
  page it restores the tabs as sleeping tabs at their places, and shows the tab that showed,
  which wakes at its position. The address names that tab's page at once. The reader mounts
  for the restore once the library has set the page's theme.
- While a tab shows, the window's address is the reader page's, so a reload loads the reader
  page. When that page loads by a reload, the record exists and its shown tab is this page's
  PDF, the page marks the record `fromReaderReload` and replaces itself with the library page
  at its last view (`LIBRARY_VIEW_KEY`), which restores the tabs. Any other load of the reader
  page removes the record, so it reaches only the reload that follows it.
