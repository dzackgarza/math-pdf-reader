---

description: "Task list for library organization: views, filing, saved searches and the inspector"
---

# Tasks: Library Organization

**Input**: Design documents from `/specs/002-library-organization/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`,
`contracts/library-organization-api.md`, and `quickstart.md`.

**Tests**: Required by the constitution. A task is `[X]` only when the implementing code and
an existing test that drives it through the real path are both named in its evidence line.
Each open task starts with a focused test that fails first.

**Note on e2e evidence**: `tests/library-e2e.test.ts` shares one bucket across its tests in
file order. A test cited here passes in a full-file run; a filtered run must include the
earlier tests that create its state (see `quickstart.md`).

## Phase 1: Foundational

- [X] T001 Define the library contract (`BucketItemSchema`, `CollectionSchema`, `RuleSchema`, `SavedSearchSchema`, `ActivitySchema`, `LibraryPayloadSchema`) in `src/contract/library.ts`
  Evidence: `src/contract/library.ts:35`, `:46`, `:97`, `:129`, `:314`, `:456`; every API test parses the payload with `LibraryPayloadSchema` (`tests/library-api.test.ts:76`).
- [X] T002 Persist the filing in `organization.json` across a server restart, and keep every PDF and its provenance when the filing file is lost, in `server/src/organization.rs`
  Evidence: `server/src/organization.rs:25` (`organization_file`), `:175` (`file_many`); `tests/library-api.test.ts:319` ("filing survives a server restart, and deleting the filing leaves every item intact").
- [X] T003 [FR-001] List every stored PDF under its store key with its reading state, and show the reading state in the table, in `server/src/library.rs` and `src/web/components/LibraryTable.tsx`
  Evidence: `server/src/library.rs:113` (`library`), `:268` (`reading`), `src/web/format.ts:25` (`readingText`), `src/web/components/LibraryTable.tsx:121`; `tests/library-api.test.ts:106`, `tests/library-api.test.ts:742`, `tests/library-e2e.test.ts:2215` (table shows "4 / 10" and "Unread").

## Phase 2: User Story 1 - Browse and filter papers (Priority: P1)

**Independent Test**: for each quick filter, seed matching and non-matching papers and compare
the displayed IDs with the expected set.

- [X] T004 [US1] [FR-002] Show exactly the matching papers for the Unread and Unfiled quick filters, with counts, and clear a filter on a second click, in `src/web/librarySelectors.ts` and `src/web/components/LibraryBar.tsx` (US1/AC1)
  Evidence: `src/web/librarySelectors.ts:60-63`, `:160` (`QUICK_FILTERS`), `src/web/components/LibraryBar.tsx:101-109`; `tests/library-e2e.test.ts:2941` (row keys equal the expected sorted set for each filter; a second click restores all rows).
- [X] T005 [US1] [FR-002] Show exactly the papers whose PDF URL fails and no mirror serves for the Offline filter, in `src/web/librarySelectors.ts` (US1/AC1)
  Evidence: `src/web/librarySelectors.ts:50` (`availability`), `:64`; `tests/library-e2e.test.ts:2862` (Offline shows only `problems`; after a serving mirror is verified it leaves the Offline view).
- [X] T006 [US1] [FR-002] List lost PDFs under Needs Re-fetch until Rebuild restores them, in `src/web/components/MissingList.tsx` and `src/web/Workspace.tsx`
  Evidence: `src/web/components/MissingList.tsx:22`, `src/web/Workspace.tsx:167`; `tests/library-e2e.test.ts:2908`.
- [X] T007 [US1] [FR-002] Show exactly the papers captured in the last 7 days for Added This Week, in `src/web/librarySelectors.ts` (US1/AC1)
  Code: `src/web/librarySelectors.ts:69-72`. No test drives this filter. See T034.
- [X] T008 [US1] [FR-002] Include a paper in no collection in the unfiled view (US1/AC3)
  Evidence: `src/web/librarySelectors.ts:60-61`; `tests/library-e2e.test.ts:2941` (Unfiled keys are `item.collections.length === 0`). The view is labelled "Unfiled".
- [X] T009 [US1] Explain an empty quick filter in the table's empty state, in `src/web/components/EmptyTable.tsx` (US1/AC2). See T033.
- [X] T010 [US1] [SC-002] Prove for every quick filter that the displayed IDs equal the expected set, including the empty set. See T034.

## Phase 3: User Story 2 - File and tag papers (Priority: P1)

**Independent Test**: create nested collections, file papers, tag them, and retrieve them
through each path.

- [X] T012 [US2] [FR-003] Create nested collections and refuse an unknown parent, in `server/src/library.rs`
  Evidence: `server/src/library.rs:393` (`new_collection`), `server/src/organization.rs:282`; `tests/library-api.test.ts:319` (`Flips` with `parentId`), `tests/library-api.test.ts:423` (unknown parent refused).
- [X] T013 [US2] [FR-003] File a paper into a collection from the inspector, the row menu and the selection bar; the paper stays in the library (US2/AC1)
  Evidence: `server/src/library.rs:365` (`bulk_collections`), `src/web/components/InspectorPanel.tsx` (collection picker); `tests/library-e2e.test.ts:798`, `tests/library-e2e.test.ts:891`, `tests/library-e2e.test.ts:2402`, `tests/library-api.test.ts:319` (filed item still listed after restart).
- [X] T014 [US2] [FR-004] Add and remove tags as deltas on one or many papers, in `server/src/library.rs`
  Evidence: `server/src/library.rs:344` (`bulk_tags`), `server/src/organization.rs:163` (`tags_of`); `tests/library-api.test.ts:479` (remove `to-read`, add `read` and `E8`), `tests/library-api.test.ts:822`, `tests/library-e2e.test.ts:891`, `tests/library-e2e.test.ts:2402`.
- [X] T015 [US2] [FR-004] Show all papers that carry a selected tag (US2/AC2)
  Code: `src/web/librarySelectors.ts:77-78`, `src/web/routes.ts:65`. No test selects a tag. See T040.
- [X] T016 [US2] [FR-005] Define, edit, store and use saved searches with rules combined by all or any
  Evidence: `server/src/library.rs:466` (`new_saved_search`), `server/src/organization.rs:432-447`, `src/web/librarySelectors.ts:131` (`itemsMatching`); `tests/library-api.test.ts:944`, `tests/library-e2e.test.ts:2696` (rows equal the all-set, then the any-set after an edit).
- [X] T017 [US2] [FR-006] Give collections rules through smart collections (saved searches with rules), per the roadmap Decision Log label mapping
  Evidence: `src/web/components/SmartCollectionDialog.tsx`, `src/web/screens/OrganizationScreen.tsx:283`, `:342`; `tests/library-e2e.test.ts:2696`.
- [X] T018 [US2] [FR-006] Store and show a collection's description, pin, Keep offline and activity history, in `server/src/organization.rs`, `src/web/screens/OrganizationScreen.tsx` and `src/web/components/CollectionCards.tsx`
  Evidence: `server/src/organization.rs:287` (`update_collection`), `:312` (`log_activity`), `src/web/screens/OrganizationScreen.tsx:131-201`, `src/web/components/CollectionCards.tsx:64`; `tests/library-api.test.ts:883` (activity entries `created`, `filed`, `tagged`, `keptOffline`), `tests/library-e2e.test.ts:2612`.
- [X] T019 [US2] [FR-006] Keep a paper in the bucket after a send to Zotero when a Keep offline collection holds it
  Code: `server/src/organization.rs:456` (`kept_offline`), `server/src/send.rs:326` (`leave`). No test sends a kept item. See T044.
- [X] T020 [US2] [FR-005] Repair saved searches that name a deleted collection or subcollection, in `server/src/organization.rs`
  Evidence: `server/src/organization.rs:368-430` (`settled`, `repaired`, `delete_collection`); `tests/library-api.test.ts:1010`.
- [X] T021 [US2] [SC-005] Update smart-collection membership when paper metadata changes (US2/AC3)
  Code: membership is computed per render in `src/web/librarySelectors.ts:95-140`. No test edits metadata and checks membership. See T039.

## Phase 4: User Story 3 - Inspect paper details (Priority: P2)

**Independent Test**: open the inspector for papers with complete and incomplete metadata and
verify the displayed states.

- [X] T022 [US3] [FR-007] Show the PDF URL's site, the capture date, the file size, the PDF URL with its last check, and the mirrors in the inspector (US3/AC1, source and mirror parts)
  Evidence: `src/web/components/InspectorPanel.tsx:712-725` (header), `:180` (`Sources`); `tests/library-e2e.test.ts:261` (site link), `tests/library-e2e.test.ts:2862` (mirror added and verified in the details pane).
- [X] T023 [US3] [FR-007] Show the original SHA-256 in the inspector (US3/AC1, hash). See T035.
- [X] T024 [US3] [FR-007] Show the cache state (Cached or Offline) in the inspector (US3/AC1, cache). See T036.
- [X] T025 [US3] [FR-007] Show the stored file's path in the inspector (US3/AC1, file). See T037.
- [X] T026 [US3] [FR-008] Show a failed metadata retrieval explicitly, with the reason
  Evidence: `src/web/Workspace.tsx:268`; `tests/library-e2e.test.ts:1766` (alert "Retrieve metadata for " for a source nothing identifies).
- [X] T027 [US3] [FR-008] [SC-004] Mark missing authors, year and abstract as missing in the inspector (US3/AC2). See T038.

## Phase 5: Edge Cases

- [X] T028 A paper may belong to multiple collections and to none. Code: `BucketItemSchema.collections` is a list. No test files one paper into two collections and checks both views. See T041.
- [X] T029 A tag may be removed while a saved search still references it. See T042.
- [X] T030 An empty result is distinguishable from a failed library load. Code: `src/web/App.tsx:45-57` (alert "The library could not be loaded"). No test drives a failed load. See T043.
- [X] T031 Keep offline is a retention preference, not a library view
  Evidence: `src/web/librarySelectors.ts:17` (`LibraryView` has no Keep offline view), `src/web/screens/OrganizationScreen.tsx:164-170` (a switch on the collection page); `tests/library-e2e.test.ts:2612` (the switch sets `keepOffline` and the page stays the collection page).

## Phase 6: Success Criteria Outside Automated Tasks

SC-001 (90% of users find a paper on the first attempt) and SC-003 (a user files a paper and
verifies it in under 20 seconds) measure people. No automated task covers them.

## Phase 7: Convergence

- [X] T033 Explain an empty quick filter or tag, collection or saved-search view in `src/web/components/EmptyTable.tsx` and its caller at `src/web/Workspace.tsx:422`: name the view and state that no PDF matches it, in place of the generic "Empty", per US1/AC2 (partial). Test first in `tests/library-e2e.test.ts` with a filter that matches nothing.
- [X] T034 Add one e2e test in `tests/library-e2e.test.ts` that seeds its own items and, for each of Unread, Unfiled, Added This Week, Offline and Needs Re-fetch, asserts the row keys equal the expected set, once with a non-empty set and once with the empty set (Needs Re-fetch empty shows "Every PDF is in the library."), per SC-002, FR-002 and US1/AC1 (partial). The existing test covers only Unread and Unfiled with non-empty sets.
- [X] T035 Show the original SHA-256 from `item.provenance.original_sha256` in the inspector's details in `src/web/components/InspectorPanel.tsx`, with an e2e test that reads it, per FR-007 and US3/AC1 (missing).
- [X] T036 Show the cache state (Cached or Offline, from `availability`) in the inspector in `src/web/components/InspectorPanel.tsx`, with the e2e test at `tests/library-e2e.test.ts:2862` extended to read it there, per FR-007 and US3/AC1 (partial). The state shows only in the table's Status column.
- [X] T037 Show the stored file's path (`item.file.path`) in the inspector in `src/web/components/InspectorPanel.tsx`, with an e2e test, per FR-007 and US3/AC1 (partial). The inspector shows the size only; the path is reachable only through Show in folder.
- [X] T038 Mark missing authors, year and abstract as missing in the inspector header in `src/web/components/InspectorPanel.tsx:699-709`, in place of hiding them, with an e2e test on an item whose metadata has none, per FR-008, SC-004 and US3/AC2 (partial).
- [X] T039 Add an e2e test in `tests/library-e2e.test.ts` that builds smart collections with title, author and tag rules, edits each item's metadata or tags through the details pane, and asserts the smart collection's rows follow each edit without a reload, per SC-005 and US2/AC3 (partial).
- [X] T040 Add an e2e test in `tests/library-e2e.test.ts` that opens `#/organization/tags/<tag>` from the Tags page for a tag on several papers and asserts the rows equal the papers that carry it, per FR-004 and US2/AC2 (partial).
- [X] T041 Add a test that files one paper into two collections and asserts it shows in both collection views and not in Unfiled, then removes both and asserts it shows in Unfiled, per the edge case "multiple collections and no collection" and FR-003 (partial).
- [X] T042 Add a test that removes a tag from its last paper while a saved search names it, and asserts the saved search stays, opens without error and shows the empty-result state from T033, per the edge case "tags removed while saved searches reference them" and FR-005 (partial).
- [X] T043 Add an e2e test that makes `GET /api/library` fail and asserts the alert "The library could not be loaded" with Reload, and that an empty library shows "No PDFs yet" with no alert, per the edge case "empty result distinguishable from a failed load" (partial). Code: `src/web/App.tsx:45-57`, `src/web/components/EmptyTable.tsx:26`.
- [X] T044 Add a test in `tests/server-send.test.ts` that sends an item held by a Keep offline collection (directly and through a subcollection) to the fake Zotero and asserts the item stays in the library, and that an item outside such a collection leaves, per FR-006 offline retention (partial). Code: `server/src/send.rs:326`.
