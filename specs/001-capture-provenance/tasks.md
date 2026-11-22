---

description: "Executable implementation tasks for PDF capture and provenance"
---

# Tasks: PDF Capture and Provenance

**Input**: Design documents from `/specs/001-capture-provenance/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`,
`contracts/`, and `quickstart.md`

**Organization**: Tasks are grouped by user story so each story can be implemented
and tested as an independent increment.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the fixtures and validation entry points used by all stories.

- [X] T001 [P] Add capture fixture metadata and expected outcomes to `tests/fixtures/README.md`
- [X] T002 [P] Add shared capture-contract test helpers for multipart and download requests in `tests/capture-helpers.ts`
- [X] T003 Confirm the focused capture commands and browser prerequisites in `specs/001-capture-provenance/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Lock down shared contracts and error semantics before story work.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Add strict capture request, response, and open-reader event assertions in `src/contract/capture.ts`
- [X] T005 [P] Define shared capture failure categories and actionable messages in `src/contract/capture.ts`
- [X] T006 Add cross-browser eligibility fixtures for MIME type, `.pdf` path, disposition filename, POST, small frame, and bucket-origin cases in `tests/fixtures/capture-cases.ts`

**Checkpoint**: Shared contracts and fixture semantics are ready for independent
user-story implementation.

---

## Phase 3: User Story 1 - Capture a browser PDF (Priority: P1) 🎯 MVP

**Goal**: Capture eligible PDF GET navigations in Chrome and Firefox, open the
reader, expose capture status, and show an explicit native-open path on failure.

**Independent Test**: Navigate to eligible and ineligible fixtures in both browsers,
then exercise an unavailable bucket and verify the visible error/native-open path.

### Tests for User Story 1

- [X] T007 [P] [US1] Add shared eligibility parity tests for Chrome and Firefox in `tests/capture-e2e.test.ts`
- [X] T008 [P] [US1] Add capture failure and native-open assertions in `tests/capture-e2e.test.ts`
- [X] T009 [P] [US1] Add real desktop reader-open and Wayland focus timing coverage in `tests/desktop_workflow.py`

### Implementation for User Story 1

- [X] T010 [US1] Normalize the shared PDF response predicate for case-insensitive MIME, path, and disposition matching in `src/extension/interception.ts`
- [X] T011 [US1] Apply the shared GET, frame, and own-origin eligibility policy to Firefox response interception in `src/extension/firefox-interception.ts`
- [X] T012 [US1] Preserve Chrome download handoff paths and convert capture failures into the shared actionable outcome in `src/extension/entrypoints/background.ts`
- [X] T013 [US1] Stream Firefox PDF responses through the shared capture request and render the native-open failure action in `src/extension/entrypoints/capture/main.ts`
- [X] T014 [US1] Surface enabled, disabled, unreachable, and stale capture states consistently in `src/extension/bucket-status.ts` and `src/extension/entrypoints/popup/main.ts`
- [X] T015 [US1] Preserve the `open-reader` event's `reader_url` and `title` contract and keep capture success independent of desktop focus in `server/src/events.rs` and `server/src/app.rs`
- [X] T016 [US1] Catch reader-open focus errors, dispatch an actionable local focus-failure status, and render it without invalidating capture in `desktop/src-tauri/src/follow-open-events.js` and `src/web/Workspace.tsx`

**Checkpoint**: Both browsers capture eligible PDFs symmetrically, leave excluded
requests native, show failures explicitly, and open the local reader when possible.

---

## Phase 4: User Story 2 - Preserve provenance (Priority: P1)

**Goal**: Ensure every stored PDF carries immutable source URL, capture time, and
original SHA-256 provenance, including deduplicated and reindexed records.

**Independent Test**: Capture a PDF, restart/reindex the store, and verify embedded
provenance and the returned reader identity.

### Tests for User Story 2

- [X] T017 [P] [US2] Add capture-response and embedded-provenance integration tests for new and existing records in `tests/server-capture.test.ts`
- [X] T018 [P] [US2] Add reindex/readback assertions for URL, timestamp, and original hash in `tests/test_titles.py`

### Implementation for User Story 2

- [X] T019 [US2] Ensure staged capture bytes, captured timestamp, and original SHA-256 are embedded before durable storage in `server/src/store.rs`
- [X] T020 [US2] Preserve immutable provenance when a duplicate capture returns an existing record in `server/src/store.rs`
- [X] T021 [US2] Validate capture request fields and return explicit non-success responses without publishing `open-reader` in `server/src/app.rs`
- [X] T022 [US2] Ensure library reindexing derives the captured PDF identity from embedded provenance rather than a sidecar-only record in `src/pdfbucket/provenance.py` and `server/src/index.rs`

**Checkpoint**: New, duplicate, restarted, and reindexed captures retain the same
source identity and embedded provenance.

---

## Phase 5: User Story 3 - Recover a source (Priority: P2)

**Goal**: Verify original URLs and mirrors, rebuild missing PDFs in deterministic
original-before-mirror order, and retain the local record on failure.

**Independent Test**: Remove local PDF bytes, provide an original URL and mirror
with controlled byte responses, and verify ordering, hash matching, restoration,
and visible unrecovered state.

### Tests for User Story 3

- [X] T023 [P] [US3] Add an attempt-order test proving the embedded original URL is tried once before mirrors in stored order in `tests/server-sources.test.ts`
- [X] T024 [P] [US3] Add mismatched-byte and unavailable-source tests proving the local record remains and recovery is unsuccessful in `tests/server-sources.test.ts`
- [X] T025 [P] [US3] Add verify-state tests for accessible, changed, and dead original/mirror locations in `tests/server-sources.test.ts`

### Implementation for User Story 3

- [X] T026 [US3] Make source verification record explicit accessible, changed, and dead outcomes with diagnostics in `server/src/sources.rs`
- [X] T027 [US3] Enforce original-before-mirror traversal and original SHA-256 matching during rebuild in `server/src/sources.rs`
- [X] T028 [US3] Preserve the missing-paper index record and return an explicit unrestored outcome when no source matches in `server/src/source_routes.rs`
- [X] T029 [US3] Keep Needs Re-fetch entries actionable and expose original URL, mirror count, and rebuild failure state in `src/web/components/MissingList.tsx`

**Checkpoint**: Recovery is deterministic, hash-safe, visible, and non-destructive.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validate the complete feature and remove cross-browser or contract drift.

- [X] T030 [P] Add contract coverage for `/capture-bytes`, `/capture-download`, `/api/import-url`, and `/api/events` in `tests/capture-contract.test.ts`
- [X] T031 [P] Add browser manifest checks for Chrome MV3 and Firefox interception permissions in `tests/extension-manifest.test.ts`
- [X] T032 Run the focused commands from `specs/001-capture-provenance/quickstart.md` and record any required fixture adjustments
- [X] T033 Run repository QC through `just test-commit` from `justfile` and resolve feature-caused failures without weakening assertions
- [X] T034 [P] Update `docs/m1.md` with the final capture eligibility, failure, focus, provenance, and recovery evidence
- [X] T035 Run `scripts/launch` against the installed build and verify capture, reader opening, focus status, and recovery behavior in the running app

## Phase 7: Convergence

- [X] T036 Define `tests/fixtures/recovery-cases.ts` and assert that at least 95% of fixtures with a matching original or mirror source are restored per SC-003
- [X] T037 Align Python support metadata with the Python 3.14 implementation boundary

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundational**: Depends on Setup and blocks all user stories.
- **Phase 3 User Story 1**: Depends on Phase 2; MVP.
- **Phase 4 User Story 2**: Depends on Phase 2 and the shared capture response; may
  run in parallel with US1 after foundational contracts are stable.
- **Phase 5 User Story 3**: Depends on the provenance model from US2 because
  recovery uses embedded original URL and hash.
- **Phase 6 Polish**: Depends on all selected stories; T035 is the final user-visible
  runtime verification and uses the normal launcher rather than manual provisioning.

### User Story Dependencies

- **US1**: Independent after Phase 2.
- **US2**: Independent after Phase 2, but shares the capture response contract with US1.
- **US3**: Depends on US2's immutable provenance behavior.

### Parallel Opportunities

- T001, T002, and T003 can run in parallel.
- T004, T005, and T006 can run in parallel.
- T007, T008, and T009 can run in parallel before US1 implementation.
- T017 and T018 can run in parallel before US2 implementation.
- T023, T024, and T025 can run in parallel before US3 implementation.
- T030, T031, and T034 can run in parallel after story implementation.

## Parallel Example: User Story 1

```text
Task T007: browser interception parity tests
Task T008: capture failure/native-open tests
Task T009: desktop focus tests
```

These tests touch separate test surfaces and can be authored together before the
implementation tasks T010–T016.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases.
2. Complete US1 capture, status, failure, reader-open, and focus behavior.
3. Run the independent US1 browser and desktop checks.
4. Stop for validation before adding provenance recovery enhancements.

### Incremental Delivery

1. Deliver US1 as the browser-capture MVP.
2. Deliver US2 with immutable embedded provenance and reindex proof.
3. Deliver US3 with deterministic original-before-mirror recovery.
4. Run Polish and repository QC only after all desired stories pass independently.

## Notes

- Every task uses the required checkbox, sequential ID, optional parallel marker,
  story label where applicable, and an exact repository path.
- Tests are included because the constitution requires boundary tests for behavior
  changes and the feature's acceptance criteria are fixture-driven.
- Do not provision manually as part of these tasks; use the repository's normal
  launcher/provisioning workflow only where the quickstart or QC gate requires it.

