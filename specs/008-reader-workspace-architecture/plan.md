# Implementation Plan: Reader Workspace Architecture

> Tier: implementation-adjacent
> Parent plan: `PLAN-PDF-BUCKET-ROADMAP` under `FEATURE-PDF-BUCKET`
> Externalized fit: existing roadmap issue tree; no new issue or PR is claimed.

**Branch**: `008-reader-workspace-architecture` (Spec Kit identifier; delivery stays on
`main`) | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

## Summary

One EmbedPDF viewer per window holds every awake PDF. Its DocumentManagerPlugin opens,
activates, orders and closes documents. The application adds four parts that EmbedPDF
2.15.1 does not supply: a tab row with a Library tab, sleep and wake of PDFs past five
awake tabs, back and forward navigation history, and shortcut scoping while the Library
is shown. Saves and reading records are application-owned and complete. The work that
remains is to make the tab row a projection of manager state only, to make the window
address follow the reader in tab mode, to restore tabs and zoom after a reload, and to
prove multi-paper page and zoom restore with an end-to-end test.

## Technical Context

**Language/Version**: TypeScript/Bun (web bundle and tests), Rust edition 2021 (server)

**Primary Dependencies**: `@embedpdf/react-pdf-viewer` 2.15.1 (npm latest) with its
DocumentManager, Commands, Scroll, Zoom and Annotation plugins; React; Radix Tabs and
ContextMenu; Axum

**Storage**: The PDF file in the item directory (annotation bytes); the filing document
(reading record: page, pages, viewedAt)

**Testing**: Puppeteer end-to-end tests over the built bundle and the real server
(`tests/library-e2e.test.ts`); real-HTTP API tests (`tests/library-api.test.ts`)

**Target Platform**: The user's Linux desktop app (Tauri window) and the loopback server

**Project Type**: Desktop application with a local web server

**Performance Goals**: SC-005: a switch between two open papers in under 2 s in 95% of
acceptance runs

**Constraints**: The application owns wiring only; EmbedPDF renders (constitution,
Architecture Constraint). Every reader page has a stable local URL. No second viewer
instance per window.

**Scale/Scope**: One window, up to five awake PDFs, any number of sleeping tabs

## Constitution Check

| Rule (Constitution 5.0.0) | Status |
| --- | --- |
| Application owns wiring only; EmbedPDF renders | Pass: one `PDFViewer`; no own renderer. The app-owned sleep, navigation history and tab row are wiring around features EmbedPDF 2.15.1 does not have. |
| Stable local URL for every PDF and reader page | Pass for `/read/<key>`. Partial in tab mode: the library window address does not follow the reader (FR-006). |
| Failing focused test first; provision before a user-visible change counts | Applies to every convergence task. |

No violation needs a Complexity Tracking entry.

## Project Structure

```text
specs/008-reader-workspace-architecture/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/reader-control.md
└── tasks.md

src/web/
├── tabs.tsx                 # Tab row, Library tab, open queue, close/sleep menu, tab keys
├── readerTabs.ts            # ReaderTabsApi the library uses to open and close readers
└── reader/
    ├── Reader.tsx           # One PDFViewer per window; projection(); scopeShortcuts; conflict bar
    ├── readerHost.ts        # ReaderControl, ReaderProjection, Held, Bookmark, host state
    ├── documents.ts         # load, openDocumentBuffer, activate, sleep, wake, close, reload
    ├── documentStorage.ts   # Position, Positions (history), DocumentStorage (saves, reading)
    ├── positions.ts         # positionOf, placeOf, restore, restoreOnceSized
    ├── viewer.ts            # viewerConfig (tabBar "never"), connectViewer event wiring
    ├── commands.ts          # bucket:library, back, forward, night mode, copy link
    └── main.tsx             # Standalone /read/<key> page; #page=N in the address
server/src/library.rs        # PUT /api/items/<key>/reading
tests/
├── library-e2e.test.ts
└── library-api.test.ts
```

**Structure Decision**: Keep the current owners. `Reader.tsx` with `documents.ts` is the
per-window manager wrapper around EmbedPDF's DocumentManagerPlugin. `tabs.tsx` displays.
No new module is added.

## Current Architecture

- **One manager (FR-001).** `Reader.tsx:253` renders one `PDFViewer`. `viewer.ts:258`
  sets `tabBar: "never"` and `viewer.ts:277` starts with no documents. Every awake PDF is
  one document in the one DocumentManagerPlugin (`documents.ts:142-146`).
- **Tab row (FR-003, FR-004).** `tabs.tsx` draws `ReaderProjection` from
  `Reader.tsx:99-119`. The projection merges `getDocumentOrder()` with app-held entries:
  loading and failed PDFs (`host.held`) and sleeping PDFs (`host.bookmarks`). Its
  `active` is `host.focus`, which the app sets (`documents.ts:193`, `:225`), not
  `getActiveDocumentId()`. The Library tab is fixed first (`tabs.tsx:30`, `:68`).
- **Sleep (FR-005, FR-009).** Past `AWAKE_READERS = 5` (`documents.ts:35`) the tab shown
  longest ago settles its save, closes in the manager and keeps a `Bookmark` with its
  `Position {pageNumber, x, y, zoom}` (`documents.ts:304-318`). Wake reopens it and
  `positions.ts` restores the place once the zoom gate opens. EmbedPDF 2.15.1 has no
  suspend.
- **Navigation history (FR-002).** `Positions` (`documentStorage.ts:70`) follows the
  PDF.js PDFHistory model. `viewer.ts:505` records a jump; `commands.ts:31`, `:79` step.
  EmbedPDF's history plugin is annotation undo, not navigation.
- **Shortcut scope.** EmbedPDF's shortcuts listen on `document`. `Reader.tsx:138-155`
  disables every shortcut category while the Library is shown. `tabs.tsx:204` adds
  capture-phase keys for tab stepping and close.
- **URL (FR-006).** The standalone page writes `#page=N` (`main.tsx:49`). In the library
  window `tabs.tsx` passes no `onPage` to `Reader`, so the address does not follow the
  reader.
- **Saves (FR-007).** `DocumentStorage` PUTs the exported bytes with `If-Match`
  (`documentStorage.ts:154`); a 412 sets the conflict (`:171`), which `Reader.tsx:222-245`
  shows with "Save my copy over it" and "Discard my copy".
- **Reading record (FR-008).** `documentStorage.ts:266-282` PUTs page, pages and edition
  to `/api/items/<key>/reading`. The record holds no zoom (`src/contract/library.ts:138`).
- **Reload (FR-009).** `/read/<key>` opens at the recorded page (`viewer.ts:59`). The
  library window restores no open tabs after a reload.

## Task Plan

### Prove multi-paper restore

- **Obligation**: US1/AC1, US1/AC2, US2/AC1, FR-005, SC-001.
- **Change**: An end-to-end test that opens two PDFs, sets a distinct page and zoom in
  each, switches between them and through the Library, and checks both.
- **Acceptance**: Each PDF shows its own page and zoom after every switch.
- **Commit boundary**: The test; a fix only if it fails.

### Prove that the tab row and the reader agree

- **Obligation**: US2/AC2, SC-002.
- **Change**: A test opens from the library and from a tab, and the selected tab, the
  shown PDF and its page agree.

### Make the address follow the reader

- **Obligation**: FR-006, FR-009.
- **Change**: Pass `onPage` in `tabs.tsx` and write `/read/<key>#page=N` (research.md).

### Restore tabs and zoom after reload

- **Obligation**: FR-008, FR-009, US3/AC3, Key Entity Reading Record (page, zoom).
- **Change**: Add zoom to the reading record; record the open tab set and reopen it.

### Measure the switch time

- **Obligation**: SC-005.
- **Change**: Time each switch in the multi-paper test and record it.

## Risks / Recovery / Stop Rules

- An EmbedPDF upgrade can add suspend, view state or scoped shortcuts. At each upgrade,
  delete the app part that upstream replaces.

## Decision Log

- Decision: Plan against the installed EmbedPDF 2.15.1, not the online docs.
  Rationale: The online docs describe `layout.tabs`, a Stage view-state API and
  viewer-scoped shortcuts that the installed package lacks.
  Date/author: 2026-11-25, planning.

## Revision Notes

- 2026-11-25: Initial plan from the current source.
