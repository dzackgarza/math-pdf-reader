# Viewer connection and document storage

How the reader configures EmbedPDF's viewer (`src/web/reader/viewer.ts`) and what it keeps for
each open PDF (`src/web/reader/documentStorage.ts`). The EmbedPDF behaviour named here is that
of `@embedpdf/react-pdf-viewer` 2.15.1.

## Viewer configuration (`viewer.ts`)

- The app opens, closes, prints and redacts nothing through the viewer's own controls
  (`VIEWER_DISABLED`).
- The PDFium engine fetches its WebAssembly from a worker, where a path names nothing, so the
  engine gets an absolute URL.
- EmbedPDF makes the hand tool the default on a touch device, which it detects by
  `ontouchstart`; WebKitGTK has `ontouchstart` on every machine. The reader turns that default
  off (`pan.defaultMode: "never"`), so a drag selects text.
- Night mode draws each page inverted, with hues turned back, so text is light on dark and
  highlights keep their colours. EmbedPDF draws a page in one box with a white background (the
  snippet's `renderPage`), holding a low-resolution image, a layer of sharp tiles and the
  annotation layers. The box is the one element inverted, because an inverted element inside
  it would turn back. The viewer follows the theme preference the page's root carries
  (`index.css`).
- The left sidebar (`sidebar-panel`) holds the thumbnails and outline tabs and opens on its
  first tab whatever its `defaultTab` says, so for the outline-on-open preference the outline
  tab goes first.
- The reader's toolbar buttons are one command each: Library, Back and Forward open the main
  toolbar's left group; Night mode and Copy PDF link close its right group. The reader in the
  library's tabs has no Library button, because the tab row holds the way back. The page
  controls move from their overlay into the toolbar. EmbedPDF keeps the commands registered at
  start; each runs the action the reader's current render holds.
- Toolbar icons are lucide icons as EmbedPDF's icon registry takes them: lucide draws paths
  with strokes of width 2, round ends and joins, in the text colour. EmbedPDF draws paths only,
  so an icon with another element is refused.
- EmbedPDF's `mode:view` closes the top secondary toolbar; `mode:annotate` opens the
  annotation toolbar, and the other editing modes open their own. The stylus mode follows
  this toolbar state, including changes made through its compact menu. The mode command
  resets the annotation lock after it changes the toolbar, so the reader locks forms and
  links again after each change.

## Keys (`viewer.ts`)

- Escape puts down the tool in hand (a highlighter, a shape) and takes up the default one,
  which selects text, as the toolbar's pointer button does. EmbedPDF binds no key to it.
- The keys a browser scrolls a page with scroll the PDF shown whatever has the focus, as
  EmbedPDF's own shortcuts answer on the whole document: its viewport holds no focus, so
  before a click the browser's own scrolling has no element to move. An arrow key scrolls 40
  CSS pixels and a page key 90 % of the viewport (Firefox's `toolkit.scrollbox` line height,
  and a page less a tenth).
- Ctrl+F opens EmbedPDF's search panel and puts the cursor in its field with the query
  selected, as a browser's find bar does. EmbedPDF's own Ctrl+F only toggles the panel and
  leaves the focus where it was; the panel's toolbar button still toggles it.
- Enter in the search field goes to the next match and Shift+Enter to the one before, as in
  a browser's find bar; EmbedPDF's field answers no key.

## Opening and activation (`viewer.ts`)

- A PDF laid out for the first time opens where its open request says, and its reading
  session starts:
  - at a saved position (a sleeping tab's bookmark): that page, place and zoom;
  - else at the page asked for (`#page=N`), else at the reading record's page, else page 1;
    at the reading record's zoom when the record has one, else at the viewer's default zoom.
- EmbedPDF's page controls read the page count when they mount, then only at a page change,
  and they can mount before the layout. The scroll that opens the PDF, to page 1 too, is that
  change.
- When a PDF becomes the one shown, it takes the focus unless the reader is loading another
  PDF to show, and its reading session starts. EmbedPDF activates another open PDF when it
  closes the active one; a PDF the reader is still loading to show keeps the focus and is
  activated once loaded. A PDF still loading reports its page once it is laid out.
- EmbedPDF's zoom plugin gates a PDF's viewport until the PDF first zooms, and it zooms only
  when the PDF loads and when the viewport is resized. A viewport that gets its size before
  the PDF's pages are laid out, and keeps it, stays gated and shows no page. Once the
  viewport has a size and the pages a layout, the reader asks for the current zoom, which
  releases the gate. A zoom asked for before the gate opens is dropped, so a restore waits
  for the gate (`restoreOnceSized`).
- The zoom that releases the gate also asks the viewport to scroll to the place it keeps, and
  the viewport applies that scroll at the next animation frame, once the pages are in the DOM.
  A restore therefore does not use `scrollToPage`: it starts a page change that names the
  asked page as current at once, and an instant one ends at once, so the zoom's later scroll
  to the top reports page 1 between the asked page and its return. A page change that is not
  instant ends only when the viewport reports that its scroll activity stopped, and on
  WebKitGTK that report can fail to come, or never comes when the viewport is already at the
  place. A restore instead asks the viewport itself for an instant scroll to the page's place
  (plugin-scroll's `getRectPositionForPage` plus the viewport's gap, the same place
  `scrollToPage` computes). The viewport applies its scroll requests in the order they were
  asked, so the restore's lands after the zoom's, and the scroll plugin reports a page only
  from where the viewport is: the PDF reports only the page it opens at (T038 in
  `specs/003-reader-annotations/tasks.md`).
- From the moment an instant scroll is asked, the viewport's scroll metrics name the place it
  asked for (clamped to the scroll range), not the place the last scroll event reported. The
  zoom plugin computes the scroll of each zoom from those metrics, and it refits a fitted
  zoom 150 ms after each viewport resize; a refit that came before the next frame drew a Next
  Page press's scroll computed from the old place, and its own scroll request, applied after
  the press's, put the reader back on the old page (CI run 45674719272). Smooth requests are
  not followed: their metrics come from the scroll events along the way.
- The reader's own moves to a place (`restore`, `scrollToStart`) record no jump in the
  back/forward history.
- A position's page coordinates are the visible part's offset in the page less the gap above
  or beside the page, in page units: EmbedPDF's `scrollToPage` adds the viewport's gap to the
  place the coordinates name (plugin-scroll's `getScrollPositionForPage`).
- EmbedPDF shows no page of a PDF that is not the active one, so the place of an inactive PDF
  is the position it had at its last scroll while it was active (`parked`).
- A page change starts before the viewport moves, so at its start the position is still the
  one the jump leaves; that position goes into the PDF's back/forward history. A smooth page
  change may never report its end.

## Document storage (`documentStorage.ts`)

What the app keeps for one PDF open in the document manager, named by its item key (also its
EmbedPDF document id): the stored bytes' entity tag, the save queue, a save conflict or
failure, the reading session, the page and zoom last recorded, and the positions the reader
jumped between.

- **Position.** The page at the viewport's top-left corner, that corner's place in the page's
  own coordinates (PDF points from the page's top-left, unscaled), and the zoom.
- **Saving** (RFC 9110 conditional requests). 700 ms after EmbedPDF commits an annotation
  change, so a burst of changes is one save, the export plugin writes the document with every
  annotation, and the PUT names the bytes it was made from in `If-Match`. The server keeps the
  bytes while the stored file still holds those bytes (or only a metadata write followed them)
  and the new bytes carry the item's provenance; it answers the new entity tag
  (`server/src/library.rs`, `entity_tag`). Saves run one after another.
- **Conflict.** When the stored PDF changed since it was loaded (412), the reader keeps
  showing the user's copy and offers to save it over the stored PDF or to discard it and load
  the stored PDF. Keep Mine first finishes the commit (its click can itself finish editing a
  note) and waits for an ordinary save in progress; its save includes the pending one.
- **Settle.** Settling sends the reading session and waits until every annotation is saved.
  It rejects while a save has failed or a save conflict is open. The click or key that
  settles can itself commit an annotation (a deselected note), so a save scheduled while one
  runs is started too, until none is left.
- **Reading record.** 1 s after the page or the zoom changes, the reader records the page, the
  page count and the zoom as the item's reading record. The record starts as the page and
  zoom the PDF opened at, and only a change is recorded, so a PDF opened and left as it opened
  stays unread. A zoom change counts from the PDF's first layout; the zoom the reader asks for
  to open the PDF is no change.
- **Back and forward** walk the positions the reader jumped between in this PDF (links,
  outline, thumbnails, search results, page entry), as PDF.js's `PDFHistory` does
  (`web/pdf_history.js`). A jump from A keeps the positions before the current one, then A;
  the place the jump leads to is stored when a step leaves it. A step back or forward is not
  itself a jump. An index past the last position means the reader is past them all, where the
  last jump led.
- **Status.** While the PDF is the active one, the reader shows its save state or a failure
  over it.
- **Dispose.** When the document leaves the manager, its session reports and stops, and no
  save is left. A page or zoom change waiting to be recorded is still recorded.

## Leaving the page

A page or zoom change is recorded after a 1 s pause. When the page unloads (`pagehide`), each open PDF sends its waiting record at once, as a `keepalive` request, so a reload or a navigation made in that second does not lose the change.

## Opening page

A PDF opens at its bookmark's exact position, else at the page the address or the caller names, else at its reading record, else at page 1. A page past the PDF's last page, or an address fragment that names no page, opens page 1 instead: the reader's status names the page asked for and the page count (FR-007), and page 1 is recorded at once.
