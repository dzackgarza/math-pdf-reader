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
  Evidence: `server/src/zotero.rs:237-306`, `server/src/send.rs:291`, `:451`;
  `tests/server-send.test.ts:101` (not running) and `:207` (no addon).
- [X] T002 Refuse a send from a page on another site or another host name, so only the
  bucket's own pages and non-browser clients can send, in `server/src/guard.rs`. Serves FR-001.
  Evidence: `server/src/send.rs:523-529` behind the guard; `tests/server-send.test.ts:230`, `:290`.

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
  `server/src/titles.rs:79` calls only `resolve_url`. `tests/server-send.test.ts:519` captures,
  reads, annotates, extracts, files, records reading, runs Retrieve metadata and deletes against
  the stub, and asserts that Zotero received only `resolve_url` and holds no item.
- [X] T004 [US1] Send to Zotero finds or makes the Zotero item for the PDF URL, then attaches
  one PDF, in `server/src/send.rs`. Per FR-003, SC-002 and US1/AC2 (citation and PDF).
  Evidence: `server/src/send.rs:143-167`, `:194-213`, `:283-310`, `:334-359`; live
  `tests/server-send-live.ts:267` (one "Full Text PDF" child), `:69` and `:106` (one item per
  paper).
- [X] T005 [US1] Use the existing Zotero item for a work Zotero already holds. Keep one PDF:
  the copy that has more annotations. In `server/src/send.rs`. Per the edge case "The citation
  store may reject a duplicate".
  Evidence: `server/src/send.rs:184-213`; live `tests/server-send-live.ts:346`.
- [ ] T006 [US1] File the item that Send to Zotero makes or finds in Zotero's selected
  collection, in `server/src/zotero.rs` and `server/src/send.rs`. Per FR-005 and US1/AC2.
  Code: `import_from_url` (`server/src/zotero.rs:357-361`) sends no `collection_keys`, so a new
  item goes to the library root. Only Send PDF Only lands in the selected collection, through
  the addon's placement.
- [ ] T007 [US1] Send to Zotero and Extract attaches the paper's existing Markdown, in
  `server/src/send.rs`. Per FR-003 and US1/AC3.
  Code: `server/src/send.rs:236-247`, `:389-391`. `tests/server-send.test.ts:136` shows only
  that Markdown is owed while Zotero is down. No test sees a Markdown attachment from an
  existing extraction.
- [ ] T008 [US1] Send to Zotero and Extract with no extraction sends the PDF first, then runs
  the configured chain up to the first success and attaches that Markdown to the same item, in
  `server/src/send.rs` and `server/src/extractions.rs`. Per FR-003, SC-002 and US1/AC5.
  Code: `server/src/send.rs:389-401`, `server/src/extractions.rs:380-391`. Live
  `tests/server-send-live.ts:209` asserts the chain order, `performed` and the Markdown child.
  It does not read the PDF child of the same item.
- [X] T009 [US1] Send PDF Only stores the PDF as a standalone attachment and needs no
  extraction. It refuses a paper whose notes or Markdown an attachment cannot hold. In
  `server/src/send.rs` and `server/src/zotero.rs`. Per FR-004, SC-005 and US1/AC4.
  Evidence: `server/src/send.rs:417-475`, `server/src/zotero.rs:430-445`; live
  `tests/server-send-live.ts:180` (attachment with no parent, `performed: ["pdf"]`);
  `tests/server-send.test.ts:341`, `:371`, `:393`.
- [ ] T010 [US1] Offer the three sends as explicit controls: the inspector button and its menu,
  the row and tab context menus, and the palette. In `src/web/components/InspectorPanel.tsx`,
  `src/web/components/ItemContextMenu.tsx`, `src/web/commands.ts` and
  `src/web/libraryActions.ts`. Per FR-001.
  Code: `InspectorPanel.tsx:796-836`, `ItemContextMenu.tsx:91-93`, `commands.ts:54-56`,
  `libraryActions.ts:627-660`. `tests/library-e2e.test.ts:927` only hovers the menu entry. No
  test sends from the UI.

## Phase 3: User Story 2 - Handle transfer failure (P1)

**Goal**: A failed transfer shows why and keeps the local paper.

**Independent Test**: Make Zotero unavailable or make it refuse, then send.

- [X] T011 [US2] With Zotero unavailable, a send answers `zotero_unavailable`, records no Zotero
  item and keeps the item in the library, in `server/src/send.rs`. Per FR-006 and US2/AC1 (server).
  Evidence: `server/src/send.rs:283-296`; `tests/server-send.test.ts:101`, `:207`, `:371`.
- [ ] T012 [US2] Show the failure reason in the inspector and keep the paper openable, in
  `src/web/components/InspectorPanel.tsx` and `src/web/libraryActions.ts`. Per FR-006, SC-003
  and US2/AC1 (UI).
  Code: `SendNotice` (`InspectorPanel.tsx:663-676`), `sendToZotero` (`libraryActions.ts:648-656`).
  No test asserts the alert. `scripts/library_screenshots.py` records the screenshots only.
- [ ] T013 [US2] After each failed send (`zotero_unavailable`, `zotero_failed`, `already_sent`,
  `pdf_only_refused`), keep the PDF bytes, the reader page and the filing unchanged. Per SC-003
  and FR-006.
  Code: the send writes the store only in `leave` after all steps succeed
  (`server/src/send.rs:326-332`). The tests assert the Zotero status only, not the PDF or the
  reader page. No test produces `zotero_failed`.
- [ ] T014 [US2] Retry after a PDF attachment failure: use the recorded Zotero item, perform
  only the owed steps, and leave exactly one PDF child, in `server/src/send.rs`. Per US2/AC2
  and the edge case "Attachment transfer may fail after citation creation".
  Code: `server/src/send.rs:292-304` records the key before the steps; `:194-213` keeps one PDF.
  No test.
- [ ] T015 [US2] When every plugin in the chain fails, keep the PDF in Zotero, attach no
  Markdown, and report each failure, in `server/src/send.rs` and `src/web/libraryActions.ts`.
  Per US2/AC3 and SC-002.
  Code: `server/src/send.rs:389-401`, `reportChain` (`libraryActions.ts:611-623`). No test.
- [ ] T016 [US2] When Zotero rejects an incomplete record (`422` from `import_from_url`), answer
  `502 zotero_failed` with Zotero's reason and record no Zotero item, in `server/src/zotero.rs`.
  Per the edge case "reject a duplicate or incomplete record" and FR-006.
  Code: `server/src/zotero.rs:337-347`, `server/src/error.rs:77`. No test.
- [ ] T017 [US2] When the selected collection is unavailable, make the send's target explicit,
  in `server/src/send.rs`. Per the edge case "A selected collection may be unavailable" and
  FR-005. Depends on T006.

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

- [ ] T019 After the last runtime change, run `just provision` and follow
  `specs/006-zotero-transfer/quickstart.md` on port 8770. Per the constitution's Development
  Workflow.

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
  Evidence: `tests/zotero-stub.ts:106`; used by `tests/server-send.test.ts:446`.
- [ ] T021 CRITICAL: Pass Zotero's selected collection to `import_from_url` in
  `server/src/zotero.rs` and `server/src/send.rs`. Read it with `get_selected_collection`, send
  its key in `collection_keys`, and file an existing item in that collection. With no
  collection selected, use the library root, as Send PDF Only does. First commit a failing
  test in `tests/server-send.test.ts` that asserts the stub received that collection key. Per
  FR-005, US1/AC2 and T006 (missing). The open question in `research.md` decides the
  no-selection case.
- [X] T022 Add an implicit-write audit to `tests/server-send.test.ts` with the T020 stub.
  Capture a PDF, open `/read/<key>`, save an annotation, run an extraction, file the item in a
  collection, tag it, add a note and run Retrieve metadata. Assert that the stub received only
  `resolve_url` and `GET /version`. Per FR-002, SC-001, US1/AC1 and US3/AC2 (partial: the code
  holds, no proof).
  Evidence: `tests/server-send.test.ts:519` (see T003).
- [ ] T023 Add a partial-failure retry test to `tests/server-send.test.ts` with the T020 stub.
  `import_from_url` succeeds and `/attach` fails. Assert `502 zotero_failed`, `zotero.status`
  `sent` with `pending` containing `pdf` and the recorded item key, and an unchanged PDF at
  `/pdf/<key>.pdf`. Then let `/attach` succeed and send again. Assert one `import_from_url` in
  total, one PDF child and the item gone from the library. Per US2/AC2, FR-006 and T014
  (missing).
- [ ] T024 Add an all-plugins-fail test for `/zotero/extracted` to `tests/server-send.test.ts`
  with the T020 stub and a manifest of failing fixture plugins
  (`tests/fixtures/plugins/extractor.sh fail`). Assert a `/attach` of the PDF before the first
  plugin runs, no `/attach` of a Markdown file, every outcome `failed`, and `performed` without
  `markdown`. Per US2/AC3, US1/AC5 and T015 (missing).
- [ ] T025 Extend the live test at `tests/server-send-live.ts:209` to read the item's children
  and assert one `application/pdf` attachment beside `<ZoteroKey>_extracted.md`. Per US1/AC5,
  SC-002 and T008 (partial).
- [ ] T026 Add a test of Send to Zotero and Extract on a paper that already has Markdown, with
  the T020 stub, to `tests/server-send.test.ts`. Assert no plugin runs, `extractions` is empty,
  and one `/attach` carries the bytes of `<root>/<key>/<key>.md` as `<ZoteroKey>_extracted.md`.
  Per FR-003, US1/AC3 and T007 (missing).
- [ ] T027 Assert the local paper after each failure in the send tests in
  `tests/server-send.test.ts`. After `zotero_unavailable`, `zotero_failed`, `already_sent` and
  `pdf_only_refused`, the SHA-256 of `/pdf/<key>.pdf` and of `<root>/<key>/<key>.pdf` is
  unchanged, `/read/<key>` answers 200, and the filing is unchanged. Per SC-003, FR-006 and T013
  (partial).
- [ ] T028 Add a test of Zotero's refusal of an unidentified source to
  `tests/server-send.test.ts`. The T020 stub answers `import_from_url` with `422` in the shape of
  `tests/fixtures/zotero/resolve-unidentified.json`. Assert `502 zotero_failed` with Zotero's
  reason and `zotero.status` `unsent`. Per the edge case "reject a duplicate or incomplete
  record" and T016 (missing).
- [ ] T029 Add a library UI test to `tests/library-e2e.test.ts`. Press **Send to Zotero** in
  the inspector against a closed Zotero port. Assert the `role="alert"` text "Zotero is not
  running: start Zotero", the button enabled again and the reader opening the paper. Repeat
  through the row context menu and the palette command "Send Selected PDF to Zotero". Per
  FR-001, FR-006, US2/AC1, T010 and T012 (missing).
- [ ] T030 Make the send's answer to an unavailable selected collection explicit in
  `server/src/send.rs`. When no Zotero window is open, the addon refuses with a conflict. Show
  it as `zotero_failed` with a message that names the cause, and record no item. Cover it with
  the T020 stub. Per the edge case "A selected collection may be unavailable", FR-005 and T017
  (missing). Depends on T021.
