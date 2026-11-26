---
description: "Task list for Deliberate Zotero Transfer"
---

# Tasks: Deliberate Zotero Transfer

**Input**: Design documents from `specs/006-zotero-transfer/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/send-api.md](contracts/send-api.md),
[quickstart.md](quickstart.md)

**Tests**: The constitution requires a failing focused test before each behaviour change.
The send behaviour was built before this spec. A task is marked done only when the
implementing code and a test that exercises it through the real HTTP or UI path both exist.
The evidence line under the task names both. "Live" marks a test in `tests/server-send-live.ts`.
That suite writes to the owner's Zotero library, runs only through `just test-zotero-live`,
and was not run for this assessment. The tier-1 tests cited were run one at a time on
2026-11-25 and passed.

**Not automated**: SC-004 (90% of users send in under 30 seconds) measures people. No task
covers it.

## Phase 1: Foundational (shared by all stories)

- [X] T001 Run the write API health check before every Zotero action and answer
  `503 zotero_unavailable` with the reason, in `server/src/zotero.rs` and `server/src/send.rs`.
  Serves FR-006 and US2/AC1.
  Evidence: `server/src/zotero.rs:248-317`, `server/src/send.rs:297`, `:457`;
  `tests/server-send.test.ts:139` (not running) and `:250` (no addon).
- [X] T002 Refuse a send from a page on another site or another host name, so only the
  bucket's own pages and non-browser clients can send, in `server/src/guard.rs`. Serves FR-001.
  Evidence: `server/src/send.rs:529-535` behind the guard; `tests/server-send.test.ts:273`, `:333`.

## Phase 2: User Story 1 - Send a paper deliberately (P1, MVP)

**Goal**: Only the user's explicit send writes a Zotero record, with the PDF and the requested
extraction output.

**Independent Test**: Capture, read, extract and file a paper with no send, then send it and
inspect the Zotero item.

- [X] T003 [US1] Prove that capture, reading, extraction, filing and Retrieve metadata make no
  Zotero write, in a new test against a recording write API stub in `tests/server-send.test.ts`.
  Per FR-001, FR-002, SC-001, US1/AC1 and US3/AC2.
  Evidence: only `server/src/send.rs` calls `import_from_url`, `attach_bytes`,
  `attach_standalone`, `set_url_and_access_date`, `attach_note` or `trash_item`;
  `server/src/titles.rs:79` calls only `resolve_url`. `tests/server-send.test.ts:556` captures,
  reads, annotates, extracts, files, records reading, runs Retrieve metadata and deletes against
  the stub, and asserts that Zotero received only `resolve_url` and holds no item.
- [X] T004 [US1] Send to Zotero finds or makes the Zotero item for the PDF URL, then attaches
  one PDF, in `server/src/send.rs`. Per FR-003, SC-002 and US1/AC2 (citation and PDF).
  Evidence: `server/src/send.rs:143-173`, `:200-219`, `:289-316`, `:340-365`; live
  `tests/server-send-live.ts:267` (one "Full Text PDF" child), `:69` and `:106` (one item per
  paper).
- [X] T005 [US1] Use the existing Zotero item for a work Zotero already holds. Keep one PDF:
  the copy that has more annotations. In `server/src/send.rs`. Per the edge case "The citation
  store may reject a duplicate".
  Evidence: `server/src/send.rs:190-219`; live `tests/server-send-live.ts:346`.
- [X] T006 [US1] File the item that Send to Zotero makes or finds in Zotero's selected
  collection, in `server/src/zotero.rs` and `server/src/send.rs`. Per FR-005 and US1/AC2.
  Evidence: `server/src/zotero.rs:370-403` (`import_from_url` with `collection_keys`,
  `selected_collection`), `server/src/send.rs:151-160`; `tests/server-send.test.ts:618` (new
  item), `:631` (held item gains the collection), `:654` (library root).
- [X] T007 [US1] Send to Zotero and Extract attaches the paper's existing Markdown, in
  `server/src/send.rs`. Per FR-003 and US1/AC3.
  Evidence: `server/src/send.rs:242-253`, `:395-397`; `tests/server-send.test.ts:764` (no
  plugin runs, `extractions` is empty, one `/attach` carries the bytes of `<key>.md` as
  `<ZoteroKey>_extracted.md`).
- [X] T008 [US1] Send to Zotero and Extract with no extraction sends the PDF first, then runs
  the configured chain up to the first success and attaches that Markdown to the same item, in
  `server/src/send.rs` and `server/src/extractions.rs`. Per FR-003, SC-002 and US1/AC5.
  Evidence: `server/src/send.rs:395-407`, `server/src/extractions.rs:380-391`. Live
  `tests/server-send-live.ts:226` asserts the chain order, `performed`, the Markdown child and
  one PDF child on the same item (`:279`); it passed against Zotero 8 with addon 3.11.2.
  `tests/server-send.test.ts:746` proves that the PDF goes before any plugin runs.
- [X] T009 [US1] Send PDF Only stores the PDF as a standalone attachment and needs no
  extraction. It refuses a paper whose notes or Markdown an attachment cannot hold. In
  `server/src/send.rs` and `server/src/zotero.rs`. Per FR-004, SC-005 and US1/AC4.
  Evidence: `server/src/send.rs:423-481`, `server/src/zotero.rs:470-485`; live
  `tests/server-send-live.ts:180` (attachment with no parent, `performed: ["pdf"]`);
  `tests/server-send.test.ts:384`, `:416`, `:438`.
- [X] T010 [US1] Offer the three sends as explicit controls: the inspector button and its menu,
  the row and tab context menus, and the palette. In `src/web/components/InspectorPanel.tsx`,
  `src/web/components/ItemContextMenu.tsx`, `src/web/commands.ts` and
  `src/web/libraryActions.ts`. Per FR-001.
  Evidence: `InspectorPanel.tsx:796-836`, `ItemContextMenu.tsx:91-93`, `commands.ts:54-56`,
  `libraryActions.ts:627-660`; `tests/library-e2e.test.ts:3162` sends from the details menu
  (and Extract), the row context menu (PDF Only), the tab context menu and the palette (Send to
  Zotero), and reads the result in Zotero; `:3134` sends from the details button.

## Phase 3: User Story 2 - Handle transfer failure (P1)

**Goal**: A failed transfer shows why and keeps the local paper.

**Independent Test**: Make Zotero unavailable or make it refuse, then send.

- [X] T011 [US2] With Zotero unavailable, a send answers `zotero_unavailable`, records no Zotero
  item and keeps the item in the library, in `server/src/send.rs`. Per FR-006 and US2/AC1 (server).
  Evidence: `server/src/send.rs:289-302`; `tests/server-send.test.ts:139`, `:250`, `:416`.
- [X] T012 [US2] Show the failure reason in the inspector and keep the paper openable, in
  `src/web/components/InspectorPanel.tsx` and `src/web/libraryActions.ts`. Per FR-006, SC-003
  and US2/AC1 (UI).
  Evidence: `SendNotice` (`InspectorPanel.tsx:663-676`), `sendToZotero`
  (`libraryActions.ts:648-656`); `tests/library-e2e.test.ts:3134` (the alert from the inspector
  button, the row context menu and the palette; the button enabled again; Open shows the paper).
- [X] T013 [US2] After each failed send (`zotero_unavailable`, `zotero_failed`, `already_sent`,
  `pdf_only_refused`), keep the PDF bytes, the reader page and the filing unchanged. Per SC-003
  and FR-006.
  Evidence: the send writes the store only in `leave` after all steps succeed
  (`server/src/send.rs:332-338`). `expectPaperKept` (`tests/server-send.test.ts:129`) checks
  the SHA-256 of the served and the stored PDF, the reader page and the filing after
  `zotero_unavailable` (`:139`), `already_sent` (`:159`), `pdf_only_refused` (`:384`) and
  `zotero_failed` (`:688`, `:788`).
- [X] T014 [US2] Retry after a PDF attachment failure: use the recorded Zotero item, perform
  only the owed steps, and leave exactly one PDF child, in `server/src/send.rs`. Per US2/AC2
  and the edge case "Attachment transfer may fail after citation creation".
  Evidence: `server/src/send.rs:298-310` records the key before the steps; `:200-219` keeps one
  PDF. `tests/server-send.test.ts:688`: the PDF attach fails (502, `pending` holds `pdf`, the
  same item key); the next send performs `["pdf", "notes"]` with one `import_from_url` in all
  and leaves one PDF child.
- [X] T015 [US2] When every plugin in the chain fails, keep the PDF in Zotero, attach no
  Markdown, and report each failure, in `server/src/send.rs` and `src/web/libraryActions.ts`.
  Per US2/AC3 and SC-002.
  Evidence: `server/src/send.rs:395-407`, `reportChain` (`libraryActions.ts:611-623`);
  `tests/server-send.test.ts:727` (server); `tests/library-e2e.test.ts:3162` (the alert lists
  "Sent to Zotero, but no plugin extracted the PDF" and each plugin's exit code).
- [X] T016 [US2] When Zotero rejects an incomplete record (`422` from `import_from_url`), answer
  `502 zotero_failed` with Zotero's reason and record no Zotero item, in `server/src/zotero.rs`.
  Per the edge case "reject a duplicate or incomplete record" and FR-006.
  Evidence: `server/src/zotero.rs:348-358`, `server/src/error.rs:77`; `tests/server-send.test.ts:788`
  (`502 zotero_failed` with the write API's reason, status `unsent`, no Zotero item).
- [X] T017 [US2] When the selected collection is unavailable, make the send's target explicit,
  in `server/src/send.rs`. Per the edge case "A selected collection may be unavailable" and
  FR-005. Depends on T006.
  Evidence: `server/src/zotero.rs:387-403` passes the write API's `409` through as
  `zotero_failed`, and `server/src/send.rs:151` reads the selection before any import;
  `tests/server-send.test.ts:667` (the message names the closed window, no item is made).

## Phase 4: User Story 3 - Use the user's connector (P2)

**Goal**: A reader page carries the citation metadata for the user's own connector action.

**Independent Test**: Open `/read/<key>` and read its `citation_*` tags.

- [X] T018 [US3] Serve reader pages with `citation_title`, `citation_author` and
  `citation_pdf_url`, in `server/src/reader.rs` and `server/templates/reader.html`. Per FR-007
  and US3/AC1.
  Evidence: `server/src/reader.rs:28-42`, `server/templates/reader.html:13-17`;
  `tests/server-capture.test.ts:55`.
- US3/AC2 (no connector action, no write) is covered by T003.

## Phase 5: Installed verification

- [X] T019 After the last runtime change, run `just provision` and follow
  `specs/006-zotero-transfer/quickstart.md` on port 8770. Per the constitution's Development
  Workflow.
  Done: `just provision` installed the build with the selected-collection step; the app on
  8770 answers; the quickstart's tier 1 and `just test-zotero-live` pass. The installed-app
  steps passed on 2026-11-26 with Zotero 7 and the local write API 3.11.2:
  1. arXiv 1706.03762v7 was imported, read, tagged and extracted with `mineru-flash`. Zotero
     had no new item.
  2. With a new Zotero collection selected, the send gave a preprint in that collection
     with one Full Text PDF, the extracted Markdown and a note. The paper left the library.
  3. With Zotero quit, Send to Zotero in the inspector for arXiv 1512.03385v1 showed
     "Zotero is not running: start Zotero"; the paper stayed unsent and `/read/` answered.
  4. Zotero's Embedded Metadata web translator, which the Connector runs, saved
     `/read/1512.03385v1` as an item with the page's `citation_title` and the PDF from
     `citation_pdf_url`.
  5. Both Zotero items went to Zotero's trash, the test collection was erased, and the
     second paper was forgotten from the library.

## Dependencies & Execution Order

- T001 and T002 hold. T003 needs the recording stub that T020 adds.
- T006 precedes T017. T014, T015 and T016 share the stub from T020.
- T012 and T010 use the library browser suite and can run beside the server tasks.
- T019 follows every runtime change.

## Parallel Opportunities

- T003, T014, T015 and T016 change only `tests/server-send.test.ts` once the stub exists.
- T010 and T012 change only `tests/library-e2e.test.ts`.

## Implementation Strategy

Add the stub write API first. With it, prove the absence of implicit writes and the failure
paths, then add selected-collection targeting with its own failing test. Provision and verify
last.

## Phase 6: Convergence

- [X] T020 Add a loopback stub of the Zotero write API for tier-1 tests in
  `tests/zotero-stub.ts`. It answers `GET /version` from `tests/fixtures/zotero/version.json`.
  It records each `/write` operation and `/attach` body, and answers or fails each one as the
  test asks, with the addon's documented JSON (addon `openapi.yaml`). It also answers the
  `/api/users/0/items/<key>/children` reads. Prerequisite for T003, T014, T015 and T016
  (missing).
  Evidence: `tests/zotero-stub.ts:106`; used by `tests/server-send.test.ts:483`.
- [X] T021 CRITICAL: Pass Zotero's selected collection to `import_from_url` in
  `server/src/zotero.rs` and `server/src/send.rs`. Read it with `get_selected_collection`, send
  its key in `collection_keys`, and file an existing item in that collection. With no
  collection selected, use the library root, as Send PDF Only does. First commit a failing
  test in `tests/server-send.test.ts` that asserts the stub received that collection key. Per
  FR-005, US1/AC2 and T006 (missing). With no collection selected, the item goes to the
  library root (`research.md`).
  Evidence: see T006. The no-selection case uses the library root.
- [X] T022 Add an implicit-write audit to `tests/server-send.test.ts` with the T020 stub.
  Capture a PDF, open `/read/<key>`, save an annotation, run an extraction, file the item in a
  collection, tag it, add a note and run Retrieve metadata. Assert that the stub received only
  `resolve_url` and `GET /version`. Per FR-002, SC-001, US1/AC1 and US3/AC2 (partial: the code
  holds, no proof).
  Evidence: `tests/server-send.test.ts:556` (see T003).
- [X] T023 Add a partial-failure retry test to `tests/server-send.test.ts` with the T020 stub.
  `import_from_url` succeeds and `/attach` fails. Assert `502 zotero_failed`, `zotero.status`
  `sent` with `pending` containing `pdf` and the recorded item key, and an unchanged PDF at
  `/pdf/<key>.pdf`. Then let `/attach` succeed and send again. Assert one `import_from_url` in
  total, one PDF child and the item gone from the library. Per US2/AC2, FR-006 and T014
  (missing).
  Evidence: `tests/server-send.test.ts:688` (see T014).
- [X] T024 Add an all-plugins-fail test for `/zotero/extracted` to `tests/server-send.test.ts`
  with the T020 stub and a manifest of failing fixture plugins
  (`tests/fixtures/plugins/extractor.sh fail`). Assert a `/attach` of the PDF before the first
  plugin runs, no `/attach` of a Markdown file, every outcome `failed`, and `performed` without
  `markdown`. Per US2/AC3, US1/AC5 and T015 (missing).
  Evidence: `tests/server-send.test.ts:727` (each outcome `failed`, `performed` is
  `["fields", "pdf"]`, the item's only child is the PDF); `:746` (a failed PDF attach stops the
  send before any plugin runs, so the paper has no extraction).
- [X] T025 Extend the live test at `tests/server-send-live.ts:226` to read the item's children
  and assert one `application/pdf` attachment beside `<ZoteroKey>_extracted.md`. Per US1/AC5,
  SC-002 and T008 (partial).
  Evidence: `tests/server-send-live.ts:279`; passed against the live Zotero (item PLNUGAQU, trashed
  by the suite's cleanup).
- [X] T026 Add a test of Send to Zotero and Extract on a paper that already has Markdown, with
  the T020 stub, to `tests/server-send.test.ts`. Assert no plugin runs, `extractions` is empty,
  and one `/attach` carries the bytes of `<root>/<key>/<key>.md` as `<ZoteroKey>_extracted.md`.
  Per FR-003, US1/AC3 and T007 (missing).
  Evidence: `tests/server-send.test.ts:764` (see T007).
- [X] T027 Assert the local paper after each failure in the send tests in
  `tests/server-send.test.ts`. After `zotero_unavailable`, `zotero_failed`, `already_sent` and
  `pdf_only_refused`, the SHA-256 of `/pdf/<key>.pdf` and of `<root>/<key>/<key>.pdf` is
  unchanged, `/read/<key>` answers 200, and the filing is unchanged. Per SC-003, FR-006 and T013
  (partial).
  Evidence: `tests/server-send.test.ts:129`, used at `:139`, `:159`, `:384`, `:688`, `:788` (see T013).
- [X] T028 Add a test of Zotero's refusal of an unidentified source to
  `tests/server-send.test.ts`. The T020 stub answers `import_from_url` with `422` in the shape of
  `tests/fixtures/zotero/resolve-unidentified.json`. Assert `502 zotero_failed` with Zotero's
  reason and `zotero.status` `unsent`. Per the edge case "reject a duplicate or incomplete
  record" and T016 (missing).
  Evidence: `tests/server-send.test.ts:788` (see T016).
- [X] T029 Add a library UI test to `tests/library-e2e.test.ts`. Press **Send to Zotero** in
  the inspector against a closed Zotero port. Assert the `role="alert"` text "Zotero is not
  running: start Zotero", the button enabled again and the reader opening the paper. Repeat
  through the row context menu and the palette command "Send Selected PDF to Zotero". Per
  FR-001, FR-006, US2/AC1, T010 and T012 (missing).
  Evidence: `tests/library-e2e.test.ts:3134` (see T012).
- [X] T030 Make the send's answer to an unavailable selected collection explicit in
  `server/src/send.rs`. When no Zotero window is open, the addon refuses with a conflict. Show
  it as `zotero_failed` with a message that names the cause, and record no item. Cover it with
  the T020 stub. Per the edge case "A selected collection may be unavailable", FR-005 and T017
  (missing). Depends on T021.
  Evidence: see T017.
- [X] T031 Name the send's target in its answer. `SendResponse` in
  `src/contract/library.ts` gets `target`: `{ kind: "collection", collectionKey }` for the
  collection selected in Zotero, `{ kind: "library" }` for the library root, and
  `{ kind: "earlier_send" }` when the send finishes an earlier send and files nothing. Send to
  Zotero takes it from `get_selected_collection`; Send PDF Only takes it from the attach
  answer's `collection_key`. First commit failing tests in `tests/server-send.test.ts`. Per
  FR-005, the edge case "A selected collection may be unavailable" and the Decision Log entry
  for the library root (`plan.md`).
  Evidence: red in 880dfb9 (each answer lacked `target`); `tests/server-send.test.ts:604`,
  `:626`, `:643`, `:662`, `:674` and `:727` pass, 23 of 23 in the file; `target_of` at
  `server/src/send.rs:255`.
- [X] T032 Keep the inspector's Open and Send to Zotero buttons usable while a send's
  message shows. After Send to Zotero and Extract fails in every plugin, the message at the
  window's lower right covers the inspector's footer, so a click on Open or Send reaches the
  message. Per FR-006 (failures are visible), US2, and the send controls of US1. First commit a
  failing test in `tests/library-e2e.test.ts`: with the message shown, the point at the
  middle of each button hits that button.
  Evidence: red in 4222c79 (expected true, received false); with the message in the library
  pane, `tests/library-e2e.test.ts` "each send control sends its way" passes at 1400 px and
  1024 px wide; screenshots `send-extract-failed-inspector-usable-1400.png` and `-1024.png`.
  Since 87a4470 the same test also clicks the details pane's Send to Zotero while the failed
  send's message shows, and that send goes to Zotero.
- [X] T033 Name where the paper went in each send's message in the library UI: "in the
  collection “<name>”", "in My Library", or "in the place an earlier send put it" (T034
  changes the last). The
  server puts the collection's name in `SendTarget`: Send to Zotero reads it from
  `get_selected_collection`; Send PDF Only reads it from Zotero's local API
  (`/api/users/0/collections/<key>`), because the attach answer gives only the key. Per
  FR-005 and US1. First commit a failing test in `tests/library-e2e.test.ts` through the
  details menu, the details pane's button, the row and tab context menus and the palette.
  Evidence: red in 87a4470 (the wait for "Sent to Zotero in the collection “Lattices”, but no
  plugin extracted the PDF" timed out); the test passes through all five controls, with the
  earlier-send message in `send-earlier-send-named.png`; `tests/server-send.test.ts` passes,
  23 of 23, with `collectionName` checked for Send to Zotero and Send PDF Only.
- [X] T034 Say "Already in Zotero from an earlier send" when a send finishes an earlier send,
  in place of "Sent to Zotero in the place an earlier send put it": the earlier send placed
  the item, so this send names no place. First commit the failing palette retry check in
  `tests/library-e2e.test.ts`.
  Evidence: red in a50d682 (the wait at the palette retry timed out); the send e2e test
  passes; `send-earlier-send-named.png` shows the message.
