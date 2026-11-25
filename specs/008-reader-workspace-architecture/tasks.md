# Tasks: Reader Workspace Architecture

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/reader-control.md](contracts/reader-control.md)

**Tests**: Constitution Development Workflow: a failing focused test before each
behaviour change. A task is `[X]` only when the source and a test that exercises the
behaviour through its real path are both named below it.

## Phase 1: Foundational (the per-window manager)

- [X] T001 Hold every awake PDF in one EmbedPDF viewer per window, with the built-in tab
  bar off, in `src/web/reader/Reader.tsx` and `src/web/reader/viewer.ts`, per FR-001
  - Evidence: `src/web/reader/Reader.tsx:253` (one `PDFViewer`), `src/web/reader/viewer.ts:258` (`tabBar: "never"`), `:277`; `src/web/reader/documents.ts:142-146` (`openDocumentBuffer`). Test `tests/library-e2e.test.ts:1413` (`readerKeys()` at `:1484` reads the one manager's document order).
- [X] T002 Route opening, activation and closing through the document manager in
  `src/web/reader/documents.ts`, per FR-002 (open, activate, close)
  - Evidence: `src/web/reader/documents.ts:142-146`, `:187-193`, `:335`. Test `tests/library-e2e.test.ts:1352` (open, Ctrl+Tab, Ctrl+W, close button at `:1395-1410`).
- [X] T003 Keep the Library tab first and available while reader tabs are open in
  `src/web/tabs.tsx`, per FR-004
  - Evidence: `src/web/tabs.tsx:30`, `:68`, `:308-322`. Test `tests/library-e2e.test.ts:1352` (Library keeps its selection; Ctrl+Tab reaches the Library row at `:1398`).

## Phase 2: User Story 1 - Work with multiple papers (P1)

- [ ] T004 [US1] Add an end-to-end test in `tests/library-e2e.test.ts` that opens two
  awake PDFs at distinct pages and zooms, switches between them, and checks each page and
  zoom, per US1/AC1, US1/AC2, FR-005, SC-001
- [X] T005 [US1] Sleep the tab shown longest ago past five awake tabs and wake it at its
  page, place and zoom in `src/web/reader/documents.ts` and `src/web/reader/positions.ts`,
  per US1/AC3, FR-005, FR-009 (reactivation)
  - Evidence: `src/web/reader/documents.ts:35`, `:304-318`; `src/web/reader/positions.ts:51`, `:87`. Test `tests/library-e2e.test.ts:1413` (`:1483-1492`: closed in the manager, zoom and scroll restored); run 2026-11-25, pass.
- [X] T006 [US1] Offer Sleep Tab in the tab menu in `src/web/tabs.tsx`, per FR-005
  - Evidence: `src/web/tabs.tsx:152-155`, `:227-228`. Test `tests/library-e2e.test.ts:1413` (`:1505`).
- [ ] T007 [US1] Time each switch in the T004 test and fail above 2 s, per SC-005

## Phase 3: User Story 2 - One coherent reader (P2)

- [ ] T008 [US2] Check in the T004 test that a Library round trip keeps each reader's
  page and zoom, per US2/AC1 and the edge case "a library view may be visible while a
  reader remains loaded"
- [ ] T009 [US2] Derive the tab row's active entry from the manager's active document in
  `src/web/reader/Reader.tsx` and `src/web/tabs.tsx`, per FR-003, SC-002
- [ ] T010 [US2] Add an end-to-end test that activates a PDF from the library and from
  its tab and checks that the tab row, the manager and the library agree on the active
  document and page, per US2/AC2, SC-002
- [X] T011 [US2] Settle the save before a reader closes and keep the reading record
  apart from the reader, per US2/AC3, FR-008 and the edge case "closing a reader must not
  delete the paper or its reading record"
  - Evidence: `src/web/reader/documents.ts:335`; `src/web/reader/documentStorage.ts:213`, `:266-282`. Tests `tests/library-e2e.test.ts:1519` (close saves the note first), `:2215` (record shown in the library after the reader is left, `:2228-2234`).
- [X] T012 [US2] Write `#page=N` into the standalone reader address and open at it, per
  FR-006 (standalone page)
  - Evidence: `src/web/reader/main.tsx:38-49`. Test `tests/library-e2e.test.ts:1110` (`:1163-1170`).
- [ ] T013 [US2] Make the library window address follow the shown reader and its page in
  `src/web/tabs.tsx`, per FR-006 (tab mode)
- [ ] T014 [US2] Put navigation history under the manager in
  `src/web/reader/documentStorage.ts`, `src/web/reader/positions.ts` and
  `src/web/reader/commands.ts`, per FR-002 (navigation)

## Phase 4: User Story 3 - Persist reader work (P3)

- [X] T015 [US3] Save the exported PDF bytes with `If-Match` and keep exactly the
  accepted bytes, per US3/AC1, FR-007, SC-003
  - Evidence: `src/web/reader/documentStorage.ts:154`; `server/src/library.rs:243` (412 on a stale tag). Tests `tests/library-api.test.ts:664` (`:700-704`), `tests/library-e2e.test.ts:2011`.
- [X] T016 [US3] Report a 412 save conflict and never overwrite silently, per US3/AC2,
  FR-007, SC-004 and the edge case "a stale save must not overwrite newer bytes"
  - Evidence: `src/web/reader/documentStorage.ts:171`, `:256`; `src/web/reader/Reader.tsx:222-245`. Tests `tests/library-api.test.ts:715-718`, `tests/library-e2e.test.ts:1579` (`:1607`, `:1625`), `:1689` (`:1723`); `:1579` run 2026-11-25, pass.
- [X] T017 [US3] Restore the saved document and last viewed page at reload of
  `/read/<key>`, per US3/AC3, FR-009 (standalone reload)
  - Evidence: `src/web/reader/viewer.ts:59`, `:376`. Tests `tests/library-e2e.test.ts:2011` (note after reload), `:2215` (`:2245` reopens at page 4).
- [X] T018 [US3] Record the last viewed page per item without a filing change, per FR-008
  - Evidence: `src/web/reader/documentStorage.ts:266-282`; `server/src/library.rs:268-297`. Tests `tests/library-api.test.ts:742`, `tests/library-e2e.test.ts:2215`.

## Outside automated tasks

- SC-005 names users, but its measure is acceptance-test runs; T007 builds it. No success
  criterion here needs a human study.

## Dependencies

- T008 and T007 extend T004.
- T009 needs owner decision D1; T010 tests it.
- T013 needs D4. T014 needs D2.

## Phase 5: Convergence

- [ ] T019 Add an end-to-end test in `tests/library-e2e.test.ts` that opens two awake PDFs, sets page 3 at 150% in one and page 5 at 80% in the other, switches A, B, Library, A, B, and checks each page and zoom with `showsPage` and `zoomOf`, per US1/AC1, US1/AC2, US2/AC1, FR-005, SC-001 (partial). The code relies on EmbedPDF per-document state; no test switches between two awake PDFs.
- [ ] T020 Derive `ReaderProjection.active` from `documents.getActiveDocumentId()` in `src/web/reader/Reader.tsx:99-119` and drop `host.focus` (`src/web/reader/readerHost.ts:109`, `src/web/reader/documents.ts:193`, `:225`), keeping loading and sleeping tabs as entries keyed by document id, per FR-003, SC-002 (contradicts). Blocked on owner decision D1.
- [ ] T021 Add an end-to-end test in `tests/library-e2e.test.ts` that opens a PDF from the library row, then shows a second by its tab, and checks that the selected tab, `getActiveDocumentId()` and the shown page agree after each step, per US2/AC2, SC-002 (missing).
- [ ] T022 Pass `onPage` from `src/web/tabs.tsx` to `Reader` and write the shown reader's address and page into the library window with `history.replaceState`, restoring the library route when the Library tab is shown, with a test in `tests/library-e2e.test.ts`, per FR-006 (partial). Blocked on owner decision D4.
- [ ] T023 Move `Positions` and the `host.moving` flag from `src/web/reader/documentStorage.ts:70`, `src/web/reader/positions.ts:51`, `:87` and `src/web/reader/viewer.ts:505` into an EmbedPDF plugin registered on the one viewer, keeping tests `tests/library-e2e.test.ts:1110`, `:1178`, `:1266` green, per FR-002 (contradicts). Blocked on owner decision D2.
- [ ] T024 Add `zoom` to `ReadingSchema` and `ReadingRequestSchema` in `src/contract/library.ts:138-156`, store it in `server/src/library.rs` `reading`, send it from `src/web/reader/documentStorage.ts:266-282`, and open at it in `src/web/reader/viewer.ts:59`, with an API test in `tests/library-api.test.ts` and a reload test in `tests/library-e2e.test.ts`, per FR-008, FR-009, US3/AC3 and the Key Entity Reading Record "page, zoom" (partial).
- [ ] T025 Record the library window's open tab keys, their order and the shown tab, and reopen them after a window reload in `src/web/tabs.tsx` and `src/web/reader/documents.ts`, with a reload test in `tests/library-e2e.test.ts`, per FR-009 and US3/AC3 (missing). A reload of the library window now shows no reader tabs.
- [ ] T026 Time each switch in the T019 test from the tab selection to `showsPage` and fail above 2 s, writing the times to the test log, per SC-005 (missing).
