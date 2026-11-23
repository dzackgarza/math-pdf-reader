---
description: "Task list for Assistant Paper Sources and Page Context"
---

# Tasks: Assistant Paper Sources and Page Context

**Input**: Design documents from `specs/005-assistant-page-context/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/assistant-api.md](contracts/assistant-api.md)

**Tests**: The specification requires failing regression tests before behavior fixes.
The real-provider check runs separately from tier 1.

## Phase 1: Setup

- [X] T001 Make raw-PDF access independent of extraction while preserving authoritative
  extraction rules in `.specify/memory/constitution.md`
- [X] T002 [P] Record the raw-page, page-context and failure contracts in
  `specs/005-assistant-page-context/plan.md`,
  `specs/005-assistant-page-context/research.md`,
  `specs/005-assistant-page-context/data-model.md` and
  `specs/005-assistant-page-context/contracts/assistant-api.md`

## Phase 2: Foundational

- [X] T003 Read one requested page from a stored PDF without saving raw text as an
  extraction in `src/pdfbucket/text.py` and `server/src/store.rs`
- [X] T004 Isolate each paper's assistant workspace and configure its bucket-only
  source permissions in `server/src/ai.rs`

## Phase 3: User Story 1 - Start a session for a stored paper (P1) 🎯 MVP

**Goal**: Every stored paper has an assistant that reads raw pages and any valid
extraction as additional context.

**Independent Test**: Open a session with no extraction, answer from a non-first raw
page, run an extraction, and use the new context in that same session.

### Tests for User Story 1

- [X] T005 [P] [US1] Prove non-first-page selection, exactly one page and the live
  raw-page request in `tests/server-ai.test.ts` and `tests/server-ai-live.ts`
- [X] T006 [US1] Reproduce and then prevent stale instructions when extraction succeeds
  after a session opens in `tests/server-ai.test.ts`

### Implementation for User Story 1

- [X] T007 [US1] Open sessions without an extraction and serve
  `GET /api/ai/pdf-text/{key}?page=N` in `server/src/ai.rs`
- [X] T008 [US1] Refresh an open session's workspace and reader-view entry after
  successful extraction placement without starting an unused assistant in
  `server/src/ai.rs` and `server/src/extractions.rs`

## Phase 4: User Story 2 - Use the reader's current page (P2)

**Goal**: The chat receives the reader's exact page and explicit paper-source pointers.

**Independent Test**: Report reader page 7, then inspect the OpenCode instruction entry
and `/api/ai/view/{key}` for page 7 and no inferred extraction line range.

### Tests for User Story 2

- [X] T009 [P] [US2] Test exact page reporting and the absence of inline full-page or
  approximate extraction content in `tests/server-ai.test.ts`

### Implementation for User Story 2

- [X] T010 [US2] Update `reader-view` on session start and every reader page report in
  `server/src/ai.rs` and `server/src/library.rs`
- [X] T011 [US2] Report the reader's first visible page through the reader API in
  `src/web/reader/documentStorage.ts` and `server/src/library.rs`

## Phase 5: User Story 3 - Keep extraction failures explicit (P3)

**Goal**: Extraction and assistant failures name their cause without disabling raw-PDF
access.

**Independent Test**: Request missing extraction text and start an unavailable
assistant; inspect their separate typed errors and then verify raw-page access.

### Tests for User Story 3

- [X] T012 [P] [US3] Test missing-extraction and assistant-unavailable errors in
  `tests/server-ai.test.ts`

### Implementation for User Story 3

- [X] T013 [US3] Keep extraction-only errors separate from raw-page and session routes
  in `server/src/ai.rs`

## Phase 6: User Story 4 - Keep the assistant inside its permissions (P3)

**Goal**: The assistant can fetch bucket paper sources but cannot execute commands,
edit files, start sub-agents or fetch arbitrary web addresses.

**Independent Test**: Inspect the generated OpenCode agent permissions and verify its
session can use the real raw-page route without extraction.

### Tests for User Story 4

- [X] T014 [P] [US4] Inspect the generated reader-agent permission configuration in
  `tests/server-ai.test.ts`

### Implementation for User Story 4

- [X] T015 [US4] Configure read-only paper-source access and deny commands, edits and
  sub-agents in `server/src/ai.rs`

## Phase 7: Cross-cutting verification

- [X] T016 [P] Describe the current raw-page, extraction-refresh and exact-page behavior
  in `README.md`, `docs/m4.md` and
  `specs/005-assistant-page-context/quickstart.md`
- [X] T017 Install the completed build with `just provision` and verify a no-extraction
  non-first-page answer and post-extraction context through the app on port 8770

## Dependencies & Execution Order

- Foundation precedes every story.
- US1 depends on T003 and T004. T005 and T006 precede their corresponding fixes.
- US2 uses the same session but has independent exact-page acceptance behavior.
- US3 and US4 can proceed independently after the foundation.
- T017 follows all functional and focused automated checks.

## Parallel Opportunities

- T002 concerns design artifacts while T003 and T004 concern existing source boundaries.
- T005 covers page selection while T006 covers the post-extraction transition.
- US3 and US4 concern separate error and permission behavior.
- T016 can update documentation while functional tests run, then T017 verifies the
  installed result.

## Implementation Strategy

Deliver US1 first: a user can ask about any stored paper without waiting for extraction.
Add exact page context, explicit failure behavior and restricted permissions without
changing that availability guarantee. Finish by provisioning and checking the real app.
