---
description: "Task list for Assistant Document Directory"
---

# Tasks: Assistant Document Directory

**Input**: Design documents from `specs/009-assistant-document-directory/`

**Prerequisites**: [type-system-prepass.md](type-system-prepass.md), [plan.md](plan.md),
[spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/assistant-api.md](contracts/assistant-api.md)

**Tests**: Every behavior change uses a failing focused real-boundary regression before
implementation. The real-provider check runs separately from tier 1.

## Phase 1: Setup

- [X] T001 Complete the bounded-context model, lifecycle rules and zero-escape-hatch
  policy in `specs/009-assistant-document-directory/type-system-prepass.md`
- [X] T002 Record the storage, OpenCode move, discovery and verification decisions in
  `specs/009-assistant-document-directory/plan.md` and its linked design artifacts

## Phase 2: Foundational document storage

- [X] T003 Add failing real-HTTP proofs for capture layout, extraction placement and
  byte/provenance-preserving flat-store migration in
  `tests/server-document-directory.test.ts` and `tests/server-extractions.test.ts`
- [X] T004 Implement `<root>/<key>/` paths and resumable non-overwriting legacy migration in
  `server/src/layout.rs`, `server/src/store.rs`, `server/src/index.rs`, `server/src/lib.rs`
  and `server/src/main.rs`
- [X] T005 Route every remaining production reader and writer, including Zotero attachment
  reads and whole-directory deletion, through the shared layout in
  `server/src/send.rs`, `server/src/store.rs` and their direct consumers

## Phase 3: Open the paper directory

- [X] T006 Verify the session location and preservation of the session ID on move.
- [X] T007 Verify a real shell read of a paper artifact through the live provider.
- [X] T008 Grant the reader shell access and direct it to its working directory.
- [X] T009 Supply the exact displayed page and optional correlation hint and retire
  the full-page text route and its instructions.

## Phase 4: User Story 2 - Enrich an already-open paper (P1)

**Goal**: A completed artifact added after session creation is available in that same chat
without a restart, source-catalog update or refresh notification.

**Independent Test**: Create a chat, add a unique unregistered artifact directly to its
paper directory, then ask for its unique content in the same session and observe a direct
file read.

### Tests for User Story 2

- [X] T010 [US2] Add a failing same-session regression for an unregistered artifact added
  after chat creation, with no OpenCode instruction update or extraction-text request, in
  `tests/server-ai.test.ts` and `tests/server-ai-live.ts`

### Implementation for User Story 2

- [X] T011 [US2] Remove extraction-driven workspace and `reader-view` refreshes while
  retaining complete-extraction placement and existing page announcements in
  `server/src/extractions.rs` and `server/src/ai.rs`

## Phase 5: Cross-cutting verification

- [X] T012 [P] Align the amended constitution and current behavior contracts in
  `.specify/memory/constitution.md`, `specs/005-assistant-page-context/`,
  `specs/009-assistant-document-directory/`, `README.md` and `docs/m4.md`
- [X] T013 Record the document-directory decision in the `PLAN-PDF-BUCKET-ROADMAP` card's
  Decision Log without changing completed issue claims
- [X] T014 Run the focused real-HTTP, Rust and TypeScript checks, execute
  `just provision`, and verify migration, PDF-only access, shell reads and same-session unknown
  artifact discovery against the provisioned app on port 8770

## Acceptance coverage

- FR-005 and SC-002: In `tests/server-ai-live.ts`, ask about visible content in
  a PDF-only scan and an obscured part of the same source. Verify the readable
  answer and the explicit limitation independently.
- FR-006 and SC-003: Read independent facts from Markdown and a separate metadata
  file in one conversation, without supplying either path.
- FR-012 and T009: In `tests/server-ai.test.ts`, open the chat with a missing
  PDF and a damaged PDF. For a valid PDF whose hint extraction fails, verify
  the recorded page and the separate hint error in the view and chat.
- FR-009 and SC-005: Check capture layout in `tests/server-document-directory.test.ts`.
  In `tests/server-import.test.ts`, verify the imported key, document path, embedded
  provenance and served PDF and reader addresses. Check page reports in
  `tests/server-ai.test.ts`, annotation saves in `tests/library-api.test.ts`,
  extraction placement in `tests/server-extractions.test.ts`, and deletion,
  export and recovery in `tests/index-export.test.ts`.

## Dependencies & Execution Order

- T001 and T002 precede every implementation task.
- T003 must fail for the current flat layout before T004. T005 completes all production
  consumers of the new layout.
- User Story 1 depends on T004 and T005. T006 and T007 precede T008 and T009.
- User Story 2 uses User Story 1's directory session. T010 precedes T011.
- T012 and T013 follow the accepted implementation behavior; T014 is last.

## Parallel Opportunities

- T007 can be prepared independently of T006 because the live test and HTTP test are
  separate files.
- T012 documentation edits can proceed while focused tests run, after T008 through T011
  define the behavior.
- T013 concerns the vault card and does not overlap repository files.

## Implementation Strategy

Deliver the real document directory first, including existing-store migration. Move the
assistant onto it with its own shell and file tools. Prove same-chat enrichment
through direct discovery, then provision the installed app and verify real user data.
