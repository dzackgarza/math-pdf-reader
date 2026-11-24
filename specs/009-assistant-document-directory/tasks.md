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

- [ ] T003 Add failing real-HTTP proofs for capture layout, extraction placement and
  byte/provenance-preserving flat-store migration in
  `tests/server-document-directory.test.ts` and `tests/server-extractions.test.ts`
- [ ] T004 Implement `<root>/<key>/` paths and resumable non-overwriting legacy migration in
  `server/src/layout.rs`, `server/src/store.rs`, `server/src/index.rs`, `server/src/lib.rs`
  and `server/src/main.rs`
- [ ] T005 Route every remaining production reader and writer, including Zotero attachment
  reads and whole-directory deletion, through the shared layout in
  `server/src/send.rs`, `server/src/store.rs` and their direct consumers

## Phase 3: User Story 1 - Ask with every available paper source (P1) 🎯 MVP

**Goal**: Each paper's assistant works in its real document directory and discovers the
original and all current enrichment without a generated source catalog.

**Independent Test**: Open PDF-only and enriched papers through real bucket/OpenCode
HTTP, inspect session location and permissions, then obtain real-provider answers from
raw page 2 and a directory artifact.

### Tests for User Story 1

- [ ] T006 [US1] Add failing HTTP proofs for document-directory session creation,
  preservation of an existing session ID through OpenCode move, generic read/glob/grep
  permissions and absence of generated paper-source catalogs in
  `tests/server-ai.test.ts`
- [ ] T007 [P] [US1] Extend the real-provider regression so raw-only page access and
  direct discovery of enriched paper artifacts both require observable tool use in
  `tests/server-ai-live.ts`

### Implementation for User Story 1

- [ ] T008 [US1] Create new sessions in and move existing sessions to the paper directory;
  replace source-catalog instructions with generic discovery and raw-page guidance in
  `server/src/ai.rs`
- [ ] T009 [US1] Remove `/api/ai/text/{key}` and update exact-page context without
  enumerating extraction or metadata artifacts in `server/src/ai.rs` and affected tests

## Phase 4: User Story 2 - Enrich an already-open paper (P1)

**Goal**: A completed artifact added after session creation is available in that same chat
without a restart, source-catalog update or refresh notification.

**Independent Test**: Create a chat, add a unique unregistered artifact directly to its
paper directory, then ask for its unique content in the same session and observe a direct
file read.

### Tests for User Story 2

- [ ] T010 [US2] Add a failing same-session regression for an unregistered artifact added
  after chat creation, with no OpenCode instruction update or extraction-text request, in
  `tests/server-ai.test.ts` and `tests/server-ai-live.ts`

### Implementation for User Story 2

- [ ] T011 [US2] Remove extraction-driven workspace and `reader-view` refreshes while
  retaining complete-extraction placement and existing page announcements in
  `server/src/extractions.rs` and `server/src/ai.rs`

## Phase 5: Cross-cutting verification

- [ ] T012 [P] Align the amended constitution and current behavior contracts in
  `.specify/memory/constitution.md`, `specs/005-assistant-page-context/`,
  `specs/009-assistant-document-directory/`, `README.md` and `docs/m4.md`
- [ ] T013 Record the document-directory decision in the `PLAN-PDF-BUCKET-ROADMAP` card's
  Decision Log without changing completed issue claims
- [ ] T014 Run the focused real-HTTP, Rust and TypeScript checks, execute
  `just provision`, and verify migration, raw-only page answers and same-session unknown
  artifact discovery against the provisioned app on port 8770

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
assistant onto it without weakening raw-page availability. Prove same-chat enrichment
through direct discovery, then provision the installed app and verify real user data.
