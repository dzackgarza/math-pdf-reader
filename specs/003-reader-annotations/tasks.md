---

description: "Executable implementation tasks for reader navigation and annotations"
---

# Tasks: Reader Navigation and Annotations

**Input**: Design documents from `/specs/003-reader-annotations/`

**Prerequisites**: `plan.md`, `spec.md`, `contracts/reader-http.md`, `quickstart.md`

**Organization**: Tasks are grouped by user story. A task is `[X]` only when the implementing
source and a test that drives the behaviour through its real path were both read; the evidence
line names both. Tab, sleep and document-manager lifecycle work belongs to
[008](../008-reader-workspace-architecture/spec.md).

**Not buildable**: SC-003 (90% of users complete a highlight-and-note task without assistance)
measures people, not software. No automated task covers it.

## Phase 1: Foundational (Reader Routes)

**Purpose**: The HTTP surface every story uses ([contract](contracts/reader-http.md)).

- [X] T001 Serve the reader page at `GET /read/{key}` and answer 404 for a key with no stored PDF in `server/src/app.rs` and `server/src/reader.rs`
  Evidence: `server/src/app.rs:439-450`, `server/src/app.rs:463`; `tests/server-capture.test.ts:81-82` (200), `tests/server-capture.test.ts:115` (`/read/missing` is 404).
- [X] T002 Serve the PDF with an `ETag` of its bytes and accept a reader save only with a matching `If-Match` that keeps the item's provenance in `server/src/app.rs` and `server/src/library.rs`
  Evidence: `server/src/app.rs:402-437`, `server/src/library.rs:194-266`; `tests/library-api.test.ts:664-750` (200 with new ETag, 412 `stale_pdf`, 428 without `If-Match`, 409 `provenance_mismatch`, 400 `not_a_pdf`).

**Checkpoint**: Reader page, PDF and save routes answer as the contract states.

---

## Phase 2: User Story 1 - Read a stored paper (Priority: P1)

**Goal**: Every stored paper opens at a stable reader address, and the address names the page.

**Independent Test**: Open papers from the library and verify stable reader access.

- [X] T003 [US1] Give every stored paper the reader address `<origin>/read/{key}` and return it from a capture, per FR-001 and US1/AC1, in `server/src/reader.rs` and `server/src/app.rs`
  Evidence: `server/src/reader.rs:13` (`reader_url_path`), `server/src/app.rs:211`, `server/src/app.rs:240`; `tests/server-capture.test.ts:68` (`reader_url` is `${origin}/read/lattices`), `tests/server-capture.test.ts:81-82`.
- [X] T004 [US1] Write the page shown into the reader URL fragment on each page change, per FR-002, in `src/web/reader/main.tsx`
  Evidence: `src/web/reader/main.tsx:49`; `tests/library-e2e.test.ts:1135-1139` (page 7, then page 3, each in `location.hash`).
- [X] T005 [US1] Open the page named by `#page=N` on reload, before the recorded reading position, per US1/AC3 and SC-005, in `src/web/reader/main.tsx` and `src/web/reader/viewer.ts`
  Evidence: test `tests/library-e2e.test.ts:2484` records page 3, opens `/read/reading#page=7`, and asserts page 7 and `#page=7`, then the same after a reload. Run 2026-11-25, pass. Source: `src/web/reader/main.tsx` (`hashPage`), `src/web/reader/viewer.ts` `startPage`.
  Source: `src/web/reader/main.tsx:38-39`, `src/web/reader/viewer.ts:55-60` (`startPage` takes the fragment first). Test: `tests/library-e2e.test.ts:1163-1172` reloads `#page=7`, but page 7 is also the last recorded reading position at that point, so the test cannot tell the fragment from the record.
- [X] T006 [US1] Show the open failure over the viewer and keep the library record, per US1/AC2 and FR-007, in `src/web/reader/Reader.tsx`
  Evidence: test `tests/library-e2e.test.ts:2524` serves bytes PDFium cannot load with the stored PDF's real `ETag` and `X-Pdf-Edition`, opens the item from its library row, asserts "The PDF could not be opened" over the viewer, then shows the Library and finds the row. Run 2026-11-25, pass. A stored file overwritten on disk is not this case: its provenance cannot be read, so the server holds no record for it, `/read/<key>` answers 404, and the library lists the file in its "cannot be read" notice (`src/web/Workspace.tsx` `UnreadableNotice`).
  Source: `src/web/reader/Reader.tsx:259-268` ("The PDF could not be opened"). No test reaches this state.
- [X] T007 [US1] Report a page outside the PDF, or a malformed page fragment, per FR-007, SC-004 and the edge case "A page may be outside the document's valid page range", in `src/web/reader/viewer.ts` and `src/web/reader/main.tsx`
  Evidence: `startPage` in `src/web/reader/viewer.ts` turns a page past the PDF's last page, or a fragment that names no page (`PageAsked` `{ fragment }` from `src/web/reader/main.tsx`), into page 1 and a status message that names the page and the page count; `laidOut` shows it and records page 1 at once (`DocumentStorage.recordNow`). Test `tests/library-e2e.test.ts:2496` (`#page=99` and `#page=abc` over a recorded page 4): red on the unfixed code (empty status), green after. Run 2026-11-25. One more run than the limit: the second run passed the `#page=99` case and failed on `#page=abc` because `page.goto` to the same path with a new fragment does not load the page again; the test now loads `about:blank` before each case.
  Source: `src/web/reader/viewer.ts:399` skips the scroll when `page > totalPages` and still records the page at `viewer.ts:398`; `main.tsx:38` drops a fragment that fails the pattern. Nothing is shown.
- [X] T008 [US1] Record the page read and reopen the paper there when the address names no page, per Constitution III, in `src/web/reader/documentStorage.ts` and `server/src/library.rs`
  Evidence: `src/web/reader/documentStorage.ts:266-301`, `server/src/library.rs:268-310`; `tests/library-e2e.test.ts:2215-2246`, `tests/library-api.test.ts:742`.

**Checkpoint**: US1 is complete when T005 to T007 are closed.

---

## Phase 3: User Story 2 - Navigate and search (Priority: P1)

**Goal**: Page box, outline and search reach exact document locations.

**Independent Test**: Use page navigation, outline entries, and known search terms.

- [X] T009 [US2] Go to a page typed into the page box, per FR-003 and US2/AC1, in `src/web/reader/viewer.ts` (page controls moved into the toolbar)
  Evidence: `src/web/reader/viewer.ts:200-213`; `tests/library-e2e.test.ts:1135-1139` (Chromium), `tests/desktop_workflow.py:793-797` (WebKitGTK, `page === 7`).
- [X] T010 [US2] Move to an outline entry's location, per FR-004 and US2/AC2, through EmbedPDF's sidebar ordered by `outlineFirst` in `src/web/reader/viewer.ts`
  Evidence: `src/web/reader/viewer.ts:224-250`, `src/web/reader/viewer.ts:386-389`; `tests/library-e2e.test.ts:1209-1234` (entry "Dual lattices" shows page 3), `tests/desktop_workflow.py:782-790`.
- [X] T011 [US2] Open search with Ctrl+F, focus its field, and step through results with Enter and Shift+Enter, per FR-004 and US2/AC2, in `src/web/reader/viewer.ts`
  Evidence: `src/web/reader/viewer.ts:120-141`, `src/web/reader/viewer.ts:557-577`; `tests/library-e2e.test.ts:2248-2289`, `tests/library-e2e.test.ts:1240-1246`.
- [X] T012 [US2] Open a PDF with no outline and no text layer, and show an empty outline and a search with no results without an error, per FR-004 and the edge case "A document may have no outline or searchable text", in `tests/library-e2e.test.ts` with a fixture in `tests/fixtures/`
  Evidence: fixture `tests/fixtures/image-only.pdf` (written by `tests/fixtures/image-only.py`: two pages of drawn shapes, no text, no outline); test `tests/library-e2e.test.ts:1303` captures it, opens the outline tab and sees EmbedPDF's "No outline available", searches "lattice" and gets a finished search with 0 results, with an empty reader status, no alert and no browser console error. Run 2026-11-25, pass.
  Source: EmbedPDF's sidebar and search panel; no repo code handles this case. No test opens such a PDF.

**Checkpoint**: US2 is complete when T012 is closed.

---

## Phase 4: User Story 3 - Save highlights and notes (Priority: P2)

**Goal**: Highlights and notes are created, edited and removed, and they stay in the PDF.

**Independent Test**: Create, reopen, edit, and remove annotations across a restart.

- [X] T013 [US3] Highlight selected text from the right-click menu, per FR-005 and US3/AC1, in `src/web/reader/pointerInput.ts`
  Evidence: `src/web/reader/pointerInput.ts:43-78` (`useSecondaryPress`); `tests/library-e2e.test.ts:2106-2164` (right-click keeps the selection, `add-highlight` saves one highlight).
- [X] T014 [US3] Highlight with the toolbar tool and the pen, and keep the highlight in the stored PDF after the paper is closed and reopened, per FR-005, FR-006 and US3/AC1, in `src/web/reader/pointerInput.ts` and `src/web/reader/documentStorage.ts`
  Evidence: `src/web/reader/pointerInput.ts:325-439`, `src/web/reader/documentStorage.ts:167-209`; `tests/desktop_workflow.py:724-826` (two highlights, close, reopen, `highlights_in(pdf) == 2`), `tests/desktop_workflow.py:1073-1073`.
- [X] T015 [US3] Write a text note and find it at its location after a reload, per FR-005, FR-006, US3/AC2 and SC-002, through EmbedPDF's free-text tool and `src/web/reader/documentStorage.ts`
  Evidence: `src/web/reader/viewer.ts:526-535` (committed event to `edited()`), `src/web/reader/documentStorage.ts:204-251`; `tests/library-e2e.test.ts:2011-2023`, `tests/library-e2e.test.ts:1519-1577` (tab closed at once), `tests/library-e2e.test.ts:2166-2213` (after a metadata write).
- [X] T016 [US3] Edit the text of an existing note and find the edited text after a reload, per FR-005, in `tests/library-e2e.test.ts`
  Evidence: test `tests/library-e2e.test.ts:2301` writes a note on a fresh capture, leaves through the reader's Library button (which settles the save), reopens and finds it, double-clicks it in Annotate mode, replaces its text with Ctrl+A and typing, leaves, reopens, and finds the new text and not the old in the stored PDF (`notesOnFirstPage`). Run 2026-11-25, pass. The first run waited for the first PUT after writing, which is the save EmbedPDF makes when it creates the note with its default text "Insert text"; the test now leaves through the Library button, as the other note tests do.
  Source: EmbedPDF's free-text editor; the save path is `viewer.ts:526-535`. No test edits an existing note.
- [X] T017 [US3] Remove a selected highlight with Delete or Backspace, and with the pen eraser, and keep the removal in the stored PDF, per FR-005, in `src/web/reader/pointerInput.ts`
  Evidence: `src/web/reader/pointerInput.ts:120-151`, `src/web/reader/pointerInput.ts:289-317`; `tests/desktop_workflow.py:1166-1171` (`highlights_in(pdf) == 0`), `tests/desktop_workflow.py:1239-1199`.
- [X] T018 [US3] Remove a text note and keep the removal in the stored PDF after a reload, per FR-005, in `tests/library-e2e.test.ts`
  Evidence: test `tests/library-e2e.test.ts:2333` writes a note on a fresh capture, leaves, reopens and finds it, selects it in Annotate mode, presses Delete, leaves, reopens, and finds it gone from the stored PDF. Run 2026-11-25, pass. The first run failed for the same test cause as the edit test (it read "Insert text" after reopening).
  Source: `src/web/reader/pointerInput.ts:120-151` deletes any selected annotation. No test removes a note.
- [X] T019 [US3] Show a failed save without claiming success, keep the user's copy, and ask before leaving, per FR-007, SC-004 and the edge case "Annotation persistence may fail", in `src/web/reader/documentStorage.ts` and `src/web/reader/documents.ts`
  Evidence: `src/web/reader/documentStorage.ts:180`, `src/web/reader/documentStorage.ts:189-201`, `src/web/reader/documents.ts:419-430`; `tests/library-e2e.test.ts:1643-1687` (500, "Not saved:", stored bytes unchanged, `beforeunload`), `tests/library-e2e.test.ts:2025-2104`.
- [X] T020 [US3] Show a save refused because the PDF changed elsewhere, and let the user save their copy over it, per FR-007, in `src/web/reader/Reader.tsx` and `src/web/reader/documentStorage.ts`
  Evidence: `src/web/reader/Reader.tsx:222-251`, `src/web/reader/documentStorage.ts:171-175`, `src/web/reader/documentStorage.ts:256-264`; `tests/library-e2e.test.ts:1579-1641`, `tests/library-e2e.test.ts:1689-1745`.
- [X] T021 [US3] Select the highlight tool with one press and leave no tool options popup open over the page, per FR-005 and COMPLAINTS.md, in `src/web/reader/viewer.ts`
  Evidence: test `tests/desktop_workflow.py:1405` in the release WebKitGTK app: after Annotate, one press on the highlight button makes `getActiveTool()?.id` `highlight`, and no tooltip, menu, dialog, list, UI-plugin menu, sidebar or modal opens that was not open before the press. Run 2026-11-25, pass with no source change: EmbedPDF's `annotation:add-highlight` command only sets the active tool. The popup in COMPLAINTS.md came from the PDF.js reader that EmbedPDF replaced. The first run failed before the press, in the `capture` fixture (the captured PDF's tab did not show in 30 s); the fixture now names the window's address, tabs, errors and text when that happens, and the second run passed.
  Source: no repo code configures the highlight tool button or its popup. No test presses the highlight tool button.
- [X] T022 [US3] Let keys reach the reader without a click first, in Chromium, per FR-005 and COMPLAINTS.md, in `src/web/reader/documents.ts` and `src/web/reader/viewer.ts`
  Evidence: `src/web/reader/documents.ts:471-484`, `src/web/reader/viewer.ts:75-115`; `tests/library-e2e.test.ts:1115-1118` (PageDown scrolls before any click), `tests/library-e2e.test.ts:1376-1378` (`keysReach`: Ctrl+= zooms with no click).
- [X] T023 [US3] Let keys reach the reader without a click first, in the desktop WebKitGTK app, per FR-005 and COMPLAINTS.md, in `tests/desktop_workflow.py`
  Evidence: test `tests/desktop_workflow.py:1427` in the release WebKitGTK app: a PDF opened from the library row with Enter takes PageDown (the scroll moves) and Ctrl+= (the zoom grows) with no click in the reader. Run 2026-11-25, pass with no source change.
  Source: as T022. No desktop test sends a key to the reader before a click.

**Checkpoint**: US3 is complete when T016, T018, T021 and T023 are closed.

---

## Phase 5: Cross-Cutting

- [X] T024 Expose `citation_title`, `citation_author` and `citation_pdf_url` on the reader page, and update `citation_title` when the title changes, per FR-008, in `server/templates/reader.html` and `src/web/reader/main.tsx`
  Evidence: `server/templates/reader.html:13-17`, `src/web/reader/main.tsx:28-36`; `tests/server-capture.test.ts:81-85`, `tests/server-titles.test.ts:155-158`, `tests/library-e2e.test.ts:1839-1850`.
- [X] T025 Keep provenance and mirrors out of the reader and the reader full width, per FR-009, in `src/web/reader/Reader.tsx`
  Evidence: test `tests/library-e2e.test.ts:2675` opens `/read/lattices` and finds neither the PDF URL, nor the SHA-256, nor the words mirror, provenance or SHA-256 in the page's text, and the reader and the viewer as wide as the window. Run 2026-11-25, pass. Source: `src/web/reader/Reader.tsx` holds no provenance panel; mirrors are in the library inspector's Sources.
  Source: `src/web/reader/Reader.tsx:213-280` renders no provenance or mirror panel. No test asserts it.
- [X] T026 Record the time from opening a reader URL with a page to that page shown, per SC-001, in `tests/library-e2e.test.ts`
  Evidence: test `tests/library-e2e.test.ts:2663` times `page.goto` of `/read/notes#page=6` to page 6 shown, fails above 5 s, and appends the time to the durable timing log `tests/timings.ts` `TIMINGS_LOG` (`$XDG_STATE_HOME/math-pdf-reader/test-timings.jsonl`, one JSON line per measure with the revision, a dirty-tree flag and the host). Run 2026-11-25, pass, 722 ms. The tab-switch times of `specs/008-reader-workspace-architecture` T019 go to the same log.
  Source: no test measures it.

---

## Dependencies & Execution Order

- Phase 1 is done; Phases 2 to 5 depend only on it.
- T007 and T005 change the same open path (`laidOut`, `main.tsx`); do them in one change.
- T016 and T018 use the `writeNote` helper in `tests/library-e2e.test.ts`.
- T021 and T023 are independent of the other open tasks.

## Implementation Strategy

1. Close the P1 gaps first: T007, T005, T006.
2. Then T012, then the US3 gaps T021, T023, T016, T018.
3. T025, then T026 last (performance comes after functionality).
4. Each fix starts with a failing focused test; check user-visible changes in the provisioned app
   ([quickstart](quickstart.md)).

---

## Phase 6: Convergence

- [X] T027 Report a page outside the PDF and a malformed `#page=` fragment in the reader: in `laidOut` in `src/web/reader/viewer.ts`, when the start page exceeds `totalPages`, show a status message through `storage.show` that names the page and the page count, open page 1 and record page 1 (the code now records the out-of-range page at `viewer.ts:398`); in `src/web/reader/main.tsx`, pass a fragment that fails `HASH_PAGE` to the same message. Prove it first with a failing test in `tests/library-e2e.test.ts` that opens `/read/reading#page=99` and `#page=abc` and asserts the message and page 1. Per FR-007, SC-004 and the edge case "A page may be outside the document's valid page range" (missing).
  Evidence: `startPage` in `src/web/reader/viewer.ts` turns a page past the PDF's last page, or a fragment that names no page (`PageAsked` `{ fragment }` from `src/web/reader/main.tsx`), into page 1 and a status message that names the page and the page count; `laidOut` shows it and records page 1 at once (`DocumentStorage.recordNow`). Test `tests/library-e2e.test.ts:2496` (`#page=99` and `#page=abc` over a recorded page 4): red on the unfixed code (empty status), green after. Run 2026-11-25. One more run than the limit: the second run passed the `#page=99` case and failed on `#page=abc` because `page.goto` to the same path with a new fragment does not load the page again; the test now loads `about:blank` before each case.
- [X] T028 Add a reload test in `tests/library-e2e.test.ts` that records a reading position on one page (as `tests/library-e2e.test.ts:2215` does), then opens `/read/reading#page=7` and asserts page 7 is shown and the fragment still reads `#page=7`, so the fragment is proven to win over the recorded position. Per US1/AC3 and SC-005 (partial).
  Evidence: test `tests/library-e2e.test.ts:2484` records page 3, opens `/read/reading#page=7`, and asserts page 7 and `#page=7`, then the same after a reload. Run 2026-11-25, pass. Source: `src/web/reader/main.tsx` (`hashPage`), `src/web/reader/viewer.ts` `startPage`.
- [X] T029 Add a test in `tests/library-e2e.test.ts` that makes a stored PDF unreadable (overwrite its bytes under `bucket.root`), opens its reader, and asserts "The PDF could not be opened" (`src/web/reader/Reader.tsx:264`) and that the item's library row stays. Per US1/AC2 and FR-007 (partial).
  Evidence: test `tests/library-e2e.test.ts:2524` serves bytes PDFium cannot load with the stored PDF's real `ETag` and `X-Pdf-Edition`, opens the item from its library row, asserts "The PDF could not be opened" over the viewer, then shows the Library and finds the row. Run 2026-11-25, pass. A stored file overwritten on disk is not this case: its provenance cannot be read, so the server holds no record for it, `/read/<key>` answers 404, and the library lists the file in its "cannot be read" notice (`src/web/Workspace.tsx` `UnreadableNotice`).
- [X] T030 Add a fixture PDF without an outline or a text layer to `tests/fixtures/`, and a test in `tests/library-e2e.test.ts` that opens it, opens the outline tab and searches a word, and asserts an empty outline, no search result, and no error. Per FR-004 and the edge case "A document may have no outline or searchable text" (partial).
  Evidence: fixture `tests/fixtures/image-only.pdf` (written by `tests/fixtures/image-only.py`: two pages of drawn shapes, no text, no outline); test `tests/library-e2e.test.ts:1303` captures it, opens the outline tab and sees EmbedPDF's "No outline available", searches "lattice" and gets a finished search with 0 results, with an empty reader status, no alert and no browser console error. Run 2026-11-25, pass.
- [X] T031 Make one press on the highlight tool button of EmbedPDF's annotation toolbar select the highlighter and leave no tool options popup open, through EmbedPDF's UI schema or a command registered in `viewerConfig` in `src/web/reader/viewer.ts` (no new toolbar component, AGENTS.md invariant 7). Prove it first with a failing test in `tests/desktop_workflow.py` that presses the button and asserts `getActiveTool()?.id` is the highlighter and no popup is open. Per FR-005 and COMPLAINTS.md (missing).
  Evidence: test `tests/desktop_workflow.py:1405` in the release WebKitGTK app: after Annotate, one press on the highlight button makes `getActiveTool()?.id` `highlight`, and no tooltip, menu, dialog, list, UI-plugin menu, sidebar or modal opens that was not open before the press. Run 2026-11-25, pass with no source change: EmbedPDF's `annotation:add-highlight` command only sets the active tool. The popup in COMPLAINTS.md came from the PDF.js reader that EmbedPDF replaced. The first run failed before the press, in the `capture` fixture (the captured PDF's tab did not show in 30 s); the fixture now names the window's address, tabs, errors and text when that happens, and the second run passed.
- [X] T032 Add a test in `tests/desktop_workflow.py` that opens a PDF from the library and, before any click in the reader, sends PageDown and Ctrl+= and asserts the scroll and zoom change in the release WebKitGTK app; fix `src/web/reader/documents.ts` or `src/web/reader/viewer.ts` if it fails. Per FR-005 and COMPLAINTS.md (partial).
  Evidence: test `tests/desktop_workflow.py:1427` in the release WebKitGTK app: a PDF opened from the library row with Enter takes PageDown (the scroll moves) and Ctrl+= (the zoom grows) with no click in the reader. Run 2026-11-25, pass with no source change.
- [X] T033 Add a test in `tests/library-e2e.test.ts` that writes a note with `writeNote`, reopens the PDF, edits the note's text in EmbedPDF's free-text editor, reloads, and asserts the edited text in `notesOnFirstPage` and not the old text. Per FR-005 and the US3 independent test (partial).
  Evidence: test `tests/library-e2e.test.ts:2301` writes a note on a fresh capture, leaves through the reader's Library button (which settles the save), reopens and finds it, double-clicks it in Annotate mode, replaces its text with Ctrl+A and typing, leaves, reopens, and finds the new text and not the old in the stored PDF (`notesOnFirstPage`). Run 2026-11-25, pass. The first run waited for the first PUT after writing, which is the save EmbedPDF makes when it creates the note with its default text "Insert text"; the test now leaves through the Library button, as the other note tests do.
- [X] T034 Add a test in `tests/library-e2e.test.ts` that writes a note, reloads, selects the note, presses Delete in Annotate mode, reloads, and asserts the note is gone from `notesOnFirstPage`. Per FR-005 and the US3 independent test (partial).
  Evidence: test `tests/library-e2e.test.ts:2333` writes a note on a fresh capture, leaves, reopens and finds it, selects it in Annotate mode, presses Delete, leaves, reopens, and finds it gone from the stored PDF. Run 2026-11-25, pass. The first run failed for the same test cause as the edit test (it read "Insert text" after reopening).
- [X] T035 Add an assertion in `tests/library-e2e.test.ts` that the reader at `/read/{key}` shows no provenance or mirror details and that the viewer fills the reader's width. Per FR-009 (partial).
  Evidence: test `tests/library-e2e.test.ts:2675` opens `/read/lattices` and finds neither the PDF URL, nor the SHA-256, nor the words mirror, provenance or SHA-256 in the page's text, and the reader and the viewer as wide as the window. Run 2026-11-25, pass. Source: `src/web/reader/Reader.tsx` holds no provenance panel; mirrors are in the library inspector's Sources.
- [X] T036 Record the time from `page.goto` of `/read/{key}#page=N` to page N shown in `tests/library-e2e.test.ts`, write it to the test's durable timing log, and fail above 5 s. Per SC-001 (missing).
  Evidence: test `tests/library-e2e.test.ts:2663` times `page.goto` of `/read/notes#page=6` to page 6 shown, fails above 5 s, and appends the time to the durable timing log `tests/timings.ts` `TIMINGS_LOG` (`$XDG_STATE_HOME/math-pdf-reader/test-timings.jsonl`, one JSON line per measure with the revision, a dirty-tree flag and the host). Run 2026-11-25, pass, 722 ms. The tab-switch times of `specs/008-reader-workspace-architecture` T019 go to the same log.
- [X] T037 Add a test in `tests/library-e2e.test.ts` that writes a note and at once navigates away from the reader page, and asserts the leave prompt and then the saved note, per FR-005 and FR-007.
  Evidence: test `tests/library-e2e.test.ts:2356`. Run 2026-11-25, pass. It checks the case that the T033 and T034 first runs seemed to show (a typed note lost on leaving); the loss came from `page.goto`, which skips `beforeunload` (`tests/TRAPS.md`).
- [ ] T038 Make a reader address with a page open at that page with no jump to page 1 on the way, for a PDF whose reading record has a fitted zoom, per FR-002 and FR-003. The red test `tests/library-e2e.test.ts:2717` fails with the reader's page changes [7, 1, 7] where [7] is expected (2026-11-25). On the provisioned app the same race once ended on page 1, with `#page=1` in the address. Ruled out: running the restore of `restoreOnceSized` (`src/web/reader/positions.ts`) a microtask after the zoom gate opens; the test still saw [7, 1, 7].
