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

## Phase 3: User Story 1 — Open the paper directory (P1, MVP)

Open a PDF-only paper and check an answer against its visible content. Open an enriched paper and verify a shell read from its directory.

- [X] T006 [US1] Verify the session location and preservation of the session ID on move in `tests/server-ai.test.ts`.
- [X] T007 [US1] Verify a real shell read of a paper artifact through the live provider in `tests/server-ai-live.ts`.
- [X] T008 [US1] Grant the reader shell access and direct it to its working directory in `server/src/ai.rs`.
- [X] T009 [US1] Supply the exact displayed page and optional correlation hint and retire
  the full-page text route and its instructions in `server/src/ai.rs`.

## Phase 4: User Story 2 - Enrich an already-open paper (P1)

**Goal**: A completed artifact added after session creation is available in that same chat
without a restart, source-catalog update or refresh notification.

**Independent Test**: Run extraction from the app with the chat open. Ask for a
passage in the published output and verify the same session reads it (T023).
T010 separately checks discovery of an unregistered file added to the directory.

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
  Decision Log using the design in `specs/009-assistant-document-directory/plan.md`
- [X] T014 Run the focused real-HTTP, Rust and TypeScript checks, execute
  `just provision`, and verify migration, PDF-only access, shell reads and same-session unknown
  artifact discovery against the provisioned app on port 8770 per `specs/009-assistant-document-directory/quickstart.md`

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
- T012 and T013 follow the accepted implementation behavior; T014 verifies the initial directory workflow. T025 verifies the final installed revision.

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

## Phase 6: Convergence

- [X] T015 [US2] CRITICAL: Preserve the last complete extraction across replacement failures in `server/src/store.rs`. Exercise a failure during publication through the extraction path and verify that the previous Markdown and its matching artifacts remain available after restart per Constitution IV and FR-008 (contradicts).
- [X] T016 Preserve other papers' directories when moving legacy artifacts in `server/src/layout.rs`. Cover a legacy `notes.pdf` beside a current `notes.md/` paper, and the corresponding PDF and extraction suffix collisions. Preserve both identities and their contents, or stop before moving an ambiguous entry and report the conflict per FR-009 and FR-010 (contradicts).
- [X] T017 [US1] Bind chat reuse in `server/src/ai.rs` to paper identity across deletion and recapture. Open a chat, delete the paper, capture a different PDF under the same key, and verify it gets a fresh conversation while a location move for the original paper retains its conversation per US1/AC3 (partial).
- [X] T018 [US2] Verify the identity of the extraction input when publishing in `server/src/extractions.rs` and `server/src/store.rs`. Exercise a plugin that finishes after its paper is deleted and the key reused. Report the stale result and preserve the replacement paper and its artifacts per FR-001 and FR-006 (partial).

## Phase 7: Convergence

- [X] T019 [US2] CRITICAL: Define the publication commit point in `server/src/extraction_publication.rs`. Exercise a failure retiring the journal after both new paths are installed. Verify the HTTP outcome and the visible Markdown and artifacts agree immediately and after restart per Constitution IV, FR-008 and T015 (contradicts).
- [X] T020 Use a no-overwrite filesystem operation for legacy moves in `server/src/layout.rs`. Treat existing directory entries, including dangling symlinks, as collisions. Verify a conflict preserves both the source file and the destination entry per FR-010 and T004 (partial).
- [X] T021 [US1] Handle a legacy chat mapping left by a key reused before upgrade in `server/src/ai.rs`. Verify identity before reusing a conversation or sending a page update. Exercise first open and first page update for an ambiguous mapping, and preserve the existing chat when continuity can be established per US1/AC3 and T017 (partial).

## Phase 8: Convergence

- [X] T022 Make deletion and key reuse safe while extraction journal cleanup is pending in `server/src/store.rs` and `server/src/extraction_publication.rs`. Extend the retirement-failure HTTP regression: restore write access, delete the paper before stopping the server, then restart and verify the library opens with the paper absent. Also verify that cleanup cannot change a replacement paper's artifacts when it reuses the key. Trace to FR-009, SC-005 and T019 (partial).

## Phase 9: User Story 2 — Read an extraction completed during chat (P1)

- [X] T023 [P] [US2] Extend `tests/server-ai-live.ts`: open the PDF-only chat, invoke an eligible extraction through the app’s extraction action, wait for publication, and ask the same session for a passage unique to the output. Compare the answer and observed file read with the published passage without supplying its path. Keep the existing unknown-file discovery case. If this exposes a failure, commit the failing case before correcting its owner in `server/src/extractions.rs` or `server/src/ai.rs`.

## Phase 10: User Story 3 — Continue reading after edition replacement (P1)

- [X] T024 [P] [US3] In `tests/server-ai.test.ts`, exercise the public replacement, session-open and reader page-report actions with distinguishable editions, using the arXiv fixtures in `tests/server-sources.test.ts`. Verify that a failed download preserves the captured session and subsequent page delivery. After success at the same key, navigate before opening a new chat and verify the old transcript receives no update. Open the fresh session, navigate again, and check both transcripts. Repeat replacement with the same arXiv version and verify the new session ID persists. If a branch fails, commit its failing regression before correcting the edition check at session open or page delivery in `server/src/ai.rs`.

## Phase 11: Installed acceptance

- [ ] T025 After T023 and T024 and any resulting fixes, provision the final revision and execute the installed-reader scenarios in `specs/009-assistant-document-directory/quickstart.md` on port 8770. Verify a same-chat answer from an app-produced extraction and an arXiv-only answer after replacement. Compare sessions and page updates across failure, success and repeat selection.

  Installed acceptance on 2026-11-24 verified the captured-edition answer, retention of the captured session after an arXiv PDF returned 404, a fresh session after successful replacement, page delivery to the current edition, and chat reuse on repeat selection. The installed arXiv extractor published Markdown in the open chat’s directory. Two answer checks remain: compare an answer with a passage unique to the replacement PDF, and verify a shell read and quotation from the published Markdown in the existing chat. The configured provider returned `429 provider.free-limit` before those answers completed.

Both remaining story checks depend on the completed US1 directory session. T023 and T024 exercise separate paths and can run in parallel. T025 consumes both outcomes.

## Phase 12: Convergence

- [x] T026 Exercise session open and page delivery overlapping same-key arXiv replacement in `tests/server-ai.test.ts`. Pause after the captured edition is selected, commit replacement, then resume the request. Compare both session IDs and reader-view entries with distinguishable PDF passages. Coordinate edition selection, page-content reads and delivery in `server/src/ai.rs` with the replacement commit in `server/src/arxiv.rs` so an old conversation cannot receive the new edition’s context per FR-013 and SC-006 (partial).
- [ ] T027 Finish the two outstanding T025 answer checks on the final installed revision using `specs/009-assistant-document-directory/quickstart.md`. Compare the fresh chat’s answer with a passage unique to the replacement PDF. In the open chat, run extraction from the app, verify a completed shell read of the published Markdown and compare the quotation with the file. Complete T025 when both checks pass per US3/AC1, US2/AC1 and SC-004 (partial).
