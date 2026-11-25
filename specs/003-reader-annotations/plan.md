# Implementation Plan: Reader Navigation and Annotations

> Tier: implementation-adjacent
> Parent plan: `PLAN-PDF-BUCKET-ROADMAP` under `FEATURE-PDF-BUCKET`
> Externalized fit: existing roadmap issue tree; no new issue or PR is claimed.
> Boundary: tabs, the document manager's lifecycle (sleep, wake, the awake-reader limit), the
> navigation-history architecture and shortcut scoping belong to
> [008 Reader Workspace Architecture](../008-reader-workspace-architecture/spec.md).

**Branch**: `003-reader-annotations` (Spec Kit identifier; delivery stays on `main`) |
**Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

## Summary

The reader exists. It is EmbedPDF (`@embedpdf/react-pdf-viewer`) configured by this repo, served
at `/read/<key>` with Highwire tags, and it saves annotations into the PDF through EmbedPDF's
export plugin and a conditional `PUT`. This plan describes that architecture and the parts of
the spec it does not yet satisfy:

- a page number outside the PDF, or a malformed page fragment, is ignored without a message;
- an open failure has a message in the source but no test;
- editing the text of an existing note has no test;
- the highlight tool's options popup stays open after the tool is selected (COMPLAINTS.md);
- keys reaching the reader without a click are tested in Chromium only, not in the desktop
  WebKitGTK app the user runs (COMPLAINTS.md);
- the full-width reader without a provenance panel has no test;
- SC-001's timing is not recorded.

## Technical Context

**Language/Version**: TypeScript on Bun (web bundle, tests), Rust edition 2021 (Axum server),
Python 3 (desktop WebKitGTK tests)

**Primary Dependencies**: EmbedPDF viewer and plugins (document-manager, scroll, zoom,
annotation, export, ui, commands, search, interaction-manager, viewport, selection), React,
Axum, askama, Puppeteer with Chromium, Selenium WebKitWebDriver, pikepdf in tests

**Storage**: The PDF file in the paper's directory. Annotations live inside the PDF. The reading
position is in the index (`PUT /api/items/{key}/reading`).

**Testing**: `tests/library-e2e.test.ts` (Puppeteer over the real server and built bundle),
`tests/desktop_workflow.py` (release app in WebKitGTK), `tests/library-api.test.ts`,
`tests/server-capture.test.ts`, `tests/server-titles.test.ts` (real HTTP)

**Target Platform**: The user's Linux desktop app (Tauri, WebKitGTK) and any browser on the
loopback origin

**Project Type**: Desktop application with a local HTTP server and a web UI

**Performance Goals**: SC-001: a known page reached in under 5 s in 95% of acceptance tests

**Constraints**: Constitution 5.0 and AGENTS.md invariants 2 (everything is a URL, citation
tags) and 7 (wiring only: EmbedPDF renders; no hand-rolled viewer)

**Scale/Scope**: One reader per window; every stored paper; highlights and free-text notes

## Constitution Check

| Principle | How this feature holds it |
| --- | --- |
| I Provenance in the PDF | A save is the exported PDF bytes; the server keeps the item's provenance on `PUT /api/items/{key}/pdf` (`tests/library-api.test.ts:664`). |
| III Reader context | The reading record sends the displayed page with the PDF edition; the server passes it to the assistant (`server/src/library.rs:304`). |
| IV Source fidelity and failures | Governs extractions and assistant answers; this feature changes neither. Reader failures are FR-007's. |
| V Tests at the real boundary | Evidence comes from Puppeteer over the built bundle and the real server, and from the release app in WebKitGTK. |
| Architecture: stable URLs | Every PDF and reader page has a loopback URL (`/pdf/{key}.pdf`, `/read/{key}`). |
| Architecture: wiring only | EmbedPDF owns rendering, outline, search, selection and annotation tools. This repo owns configuration, commands, persistence wiring and the reader page. |
| Workflow | Each fix starts with a failing focused test. User-visible changes are checked in the provisioned app. |

No violation needs a justification.

## Project Structure

```text
specs/003-reader-annotations/
├── spec.md
├── plan.md
├── quickstart.md
├── contracts/reader-http.md
└── tasks.md

server/
├── src/reader.rs            # pdf_url_path, reader_url_path, reader_page (template data)
├── src/app.rs               # GET /pdf/{file} (ETag), GET /read/{key} (404 unknown_item)
├── src/library.rs           # PUT /api/items/{key}/pdf (If-Match), PUT .../reading
└── templates/reader.html    # citation_title, citation_author, citation_pdf_url, #reader
src/web/
├── reader/main.tsx          # /read/<key> entry: #page=N in, replaceState on page change
├── reader/Reader.tsx        # viewer, conflict bar, open-failure cover, save status
├── reader/viewer.ts         # viewerConfig, commands, toolbar buttons, laidOut, connectViewer
├── reader/documentStorage.ts# save chain, 412 conflict, reading record, Positions
├── reader/documents.ts      # load, open, beforeunload, keys as reading input
├── reader/positions.ts      # page and in-page position restore
├── reader/commands.ts       # back, forward, library, night mode, copy link
├── reader/pointerInput.ts   # right-click highlight, Delete/Backspace, pen and eraser
├── reader/readerHost.ts     # shared reader state and types
└── tabs.tsx                 # in-app tabs over one Reader (feature 008)
tests/
├── library-e2e.test.ts
├── desktop_workflow.py
├── library-api.test.ts
├── server-capture.test.ts
└── server-titles.test.ts
```

**Structure Decision**: Extend the current owners. `viewer.ts` owns the reaction to a laid-out
PDF and its requested page; `Reader.tsx` owns visible reader messages; `main.tsx` owns the
reader URL. No new module and no replacement of an EmbedPDF component.

## Design

### Reader address and page (FR-001, FR-002, FR-003, US1)

`/read/<key>` is rendered by `read` in `server/src/app.rs:439` with `reader_page` from
`server/src/reader.rs`. An unknown key is a 404 `unknown_item`. `main.tsx` parses
`#page=N` (`^#page=([1-9][0-9]*)$`) and passes it to `control.open`. `laidOut`
(`viewer.ts:376`) scrolls to that page. Each page change calls `onPage`, which replaces the
fragment. The in-app tab reader passes no `onPage`; its address is the library page (008).

Gap: `laidOut` scrolls only `if (page <= totalPages)` (`viewer.ts:399`) and still records that
page as `storage.recordedPage`. A fragment that fails the regex is dropped in `main.tsx`.
Neither case shows a message. The fix shows a reader status message through the existing
`storage.show` channel, opens the PDF at page 1, and records page 1.

### Outline and search (FR-004, US2)

EmbedPDF's sidebar holds thumbnails and the outline; `outlineFirst` and the `outlineOnOpen`
preference order them. `bucket:find` (Ctrl+F) opens the search panel and focuses its field;
`useSearchKeys` maps Enter and Shift+Enter to next and previous result. A PDF without an
outline or text layer shows EmbedPDF's own empty states; no repo code handles that case.

### Annotations (FR-005, FR-006, US3)

EmbedPDF's annotation plugin creates, selects, edits and deletes. This repo adds:
`useSecondaryPress` (right-click keeps the selection so its menu offers highlight),
`useAnnotationDelete` (Delete and Backspace in Annotate mode), `usePen` (a pen highlights in
View mode, the eraser deletes). Each `committed` annotation event calls
`DocumentStorage.edited()`; after 700 ms the chain exports the PDF with `saveAsCopy()` and
sends `PUT /api/items/{key}/pdf` with `If-Match`.

Gaps from COMPLAINTS.md, both FR-005:

- Selecting the highlight tool in EmbedPDF's annotation toolbar leaves the tool's options popup
  open over the page. The fix is configuration of EmbedPDF's UI schema or a command that closes
  the popup on selection; a new toolbar component is out of scope (invariant 7).
- Keys must reach the reader without a click. `documents.ts:471` and `viewer.ts:75` handle keys
  at the document. Chromium tests prove it; the desktop WebKitGTK app has no such test.

### Failures (FR-007, SC-004)

| Failure | Where shown | Source |
| --- | --- | --- |
| PDF cannot open | cover over the viewer, "The PDF could not be opened: ..." | `Reader.tsx:259` |
| Save refused, PDF changed elsewhere (412) | conflict bar, role=alert | `documentStorage.ts:171`, `Reader.tsx:222` |
| Save failed otherwise | status "Not saved: ..." | `documentStorage.ts:180` |
| Reading position not recorded | status "Page not recorded: ..." | `documentStorage.ts:296` |
| Leaving with unsaved edits | `beforeunload` prompt | `documents.ts:428` |
| Page outside the PDF, malformed fragment | none | gap |

### Citation metadata (FR-008)

`server/templates/reader.html` emits `citation_title`, one `citation_author` per author, and
`citation_pdf_url` as `{{origin}}{{pdf_path}}`. `main.tsx` updates `citation_title` when
metadata changes the title while the page is open.

### Inspector boundary (FR-009)

The reader shows no provenance or mirror panel; the inspector owns them (AGENTS.md mockup
table). The copy-link button copies the PDF URL from the item's provenance. No test asserts the
absence of a provenance panel in the reader.

## Risks / Recovery / Stop Rules

- The popup fix depends on EmbedPDF's UI schema. If no schema or command closes the popup,
  record a Decision Log entry for the owner instead of writing a toolbar.
- Desktop WebKitGTK tests run only through `just test-desktop`; keep the new focus test in
  `tests/desktop_workflow.py` beside the existing reader tests.

## Decision Log

- 2026-11-25: Tabs, sleep, the awake-reader limit, the `Positions` history architecture and
  `scopeShortcuts` are 008's. This feature tests their user-visible navigation results only.
