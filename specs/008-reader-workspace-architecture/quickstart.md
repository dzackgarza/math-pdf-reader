# Quickstart: Reader Workspace Validation

Run each check on the provisioned app (`just provision`, port 8770) after the last change
it covers. The automated forms live in `tests/library-e2e.test.ts`.

1. **Two papers (US1/AC1, AC2, SC-001, SC-005).** Open paper A at page 3, zoom 150%.
   Open paper B at page 5, zoom 80%. Switch A, B, Library, A, B. Each shows its own page
   and zoom. Each switch shows the page in under 2 s.
2. **Sleep (US1/AC3).** Open six papers. The tab shown longest ago sleeps. Show it. It
   opens at the same page, place and zoom.
3. **Active document (US2/AC2, SC-002).** Open A from the library, then show B by its
   tab. The tab row, the address and the library agree that B is active.
4. **Close (US2/AC3).** Write a note in A and close its tab. Reopen A: the note is there
   and the library shows its last viewed page.
5. **Address (FR-006).** In a reader tab, go to page 7. The window address names the
   paper and page 7. Open that address in a new window: it shows page 7.
6. **Save and conflict (US3/AC1, AC2).** Write a note: it saves. Change the PDF from a
   second view, then write a note in the first: an alert shows the conflict and no bytes
   are overwritten.
7. **Reload (US3/AC3, FR-009).** With two tabs open, reload the window. The tabs come
   back at their pages and zoom, with notes present.

## How the reader tests in tests/library-e2e.test.ts work

EmbedPDF draws its UI in the viewer's shadow root; Puppeteer's `>>>` reaches into it.
EmbedPDF draws each page in a white box (its snippet's `renderPage`), and draws the page's
own text into images, not elements. The viewer is shared by all tabs, so page images alone
can still belong to a different PDF: `readerLoaded` waits for the shown key, a laid-out
document and an image inside a page box.

- **Page box.** The page box below the PDF holds a typed page before EmbedPDF moves there,
  so the shown page is read from the page box and from EmbedPDF's view. A PDF of one page
  has no page box, so `firstPageCorner` scrolls through EmbedPDF itself. EmbedPDF draws only
  the pages near the shown one; page 1 is the highest page drawn once its top is in the
  window. A zoom that is still settling moves and resizes the page, so the corner is read
  once it stays in place.
- **Scrolls.** `scrollBy` waits until a smooth scroll stops, then scrolls at once through
  EmbedPDF's viewport. Native wheel scrolling rounds fractional device pixels at page
  boundaries, so the wheel test allows a 1 px difference.
- **Keys.** The reader shown answers its keys at once: Ctrl+= zooms with no click first,
  and the keys that scroll a page scroll the PDF. Keys pressed inside the PDF reach the tab
  strip.
- **Notes.** A note is written with the free-text tool from the Annotate toolbar. That
  toolbar opens below the main one and moves the pages down, so the page corner is read
  after it opens. After a note, the tool stays selected, and its button would deselect it.
  EmbedPDF ends a note's edit only when the note loses focus, so the test clicks the page
  before it places the next note.
- **History.** A page typed into the page box, a link, an outline entry and a search match
  are jumps; the reader's address names the page shown. A scroll inside a page moves no
  page, and Back returns to that place in the page, not to its top. The outline sidebar
  opens first, because opening it can change the page scale and so every scroll position.
  Back, Forward and Back with no wait end at page 2's place: the search jump replaced the
  outline jump in the history after it.
- **Fixture positions.** In the link test, the reference to Section 3 on page 1 links to
  page 3; its box is at 246–253 pt across and 161–170 pt down the 612 pt page. In the
  highlight test, the problem set's first exercise line is at 237–246 pt from the top of its
  595 pt page, from 146 pt across. "unimodular" is on pages 6 and 10.
- **Tabs.** A PDF loads while its tab is hidden and has drawn its pages when the tab shows.
  The Library tab answers Enter itself, so the test clicks the row to give the row focus.
  The tab strip is the way back, so a reader in a tab has no Library button. A tab that
  sleeps has its PDF closed by EmbedPDF, which closes documents asynchronously; it keeps a
  place inside page 3 and its zoom through the sleep.
- **Saves.** The reader's Library button leaves once every annotation is saved and the
  reading session is reported. A test holds the note's save to prove that leaving asks
  first while two saves (the note and then its text) are in flight. A read-only store lets
  the server read the PDF but stops its atomic save; the test watches a real navigation and
  asserts that dismissing the warning keeps the reader open. When a metadata write lands
  after the reader loaded, the server writes the metadata into the reader's older copy, and
  the answered tag names the bytes the next save starts from. When another window saves
  the PDF first, closing the tab asks first, Cancel keeps the tab, and the desktop tray's
  Quit (`follow-open-events.js`) hears that a reader cannot settle.
- **Readings.** A page shown for six seconds is a reading that the tab owes the bucket when
  it closes. Twelve seconds of reading is under the default minimum of thirty, so no
  timeline session appears.
- **Titles.** Zotero identifies the arXiv URL once the test lets it answer; nothing
  identifies other URLs. The PDF from that URL has no title of its own, so it opens under
  its link text. A new page comes to the front, and Chromium draws no frames for a page
  behind it, so the test brings the library to the front again before it checks the tab.
  The PDF's own reader page carries the title and citation tags that a Zotero Connector
  reads.
- **Theme.** The library background is the surface token in `index.css`; the reader follows
  EmbedPDF's colour scheme. The night-mode test reads a screenshot pixel in page 1's white
  margin. A reader opened later also opens in night mode.
