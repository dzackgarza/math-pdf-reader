# Implementation Plan: Deliberate Zotero Transfer

**Branch**: `006-zotero-transfer` (Spec Kit identifier; delivery stays on `main`) |
**Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-zotero-transfer/spec.md`

## Summary

The send action exists. Three HTTP routes write to Zotero through the local write API
addon on port 23119: Send to Zotero, Send to Zotero and Extract, and Send PDF Only. No
other server path writes to Zotero. Reader pages carry Highwire `citation_*` tags for
the user's own Zotero Connector. This plan records that architecture and the parts the
spec requires that the source does not have:

- Send to Zotero does not file the item in Zotero's selected collection (FR-005).
- No automated test proves that capture, reading, extraction and filing make no Zotero
  write (FR-002, SC-001).
- No automated test exercises a Zotero failure after the Zotero item exists, an
  extraction chain where every plugin fails, or the visible failure in the library UI
  (US2, FR-006, SC-003).

## Technical Context

**Language/Version**: Rust edition 2021 (server), TypeScript with Bun and React (library UI
and tests)

**Primary Dependencies**: Axum and Tokio, reqwest (Zotero client), Zod contracts in
`src/contract/library.ts`, the Zotero local write API addon (with the
`import_store_attachments` capability)

**Storage**: The filing document `organization.json` holds each item's `ZoteroRecord`. The
paper directory `<root>/<key>/` holds the PDF and the Markdown the send reads. Zotero holds
the citation record and its attachments.

**Testing**: Bun real-HTTP tests against `serveBucket` (`tests/server-send.test.ts`), the
opt-in mutating live suite against the real Zotero (`tests/server-send-live.ts`, run by
`just test-zotero-live`), the library browser suite (`tests/library-e2e.test.ts`), and the
reader tag test (`tests/server-capture.test.ts`)

**Target Platform**: The user's Linux desktop app on loopback port 8770, with Zotero 8 on
loopback port 23119

**Project Type**: Desktop application with a local HTTP server

**Performance Goals**: None set by the spec. The send waits as long as Zotero takes.

**Constraints**: Zotero is written only by an explicit send or by the user's connector
click (AGENTS.md invariant 3). Fail loudly: no retry loop, no silent fallback. A failed
send keeps the local paper. Tier-1 tests must not write to the user's real Zotero library.

**Scale/Scope**: One user, one Zotero library, one item per send

## Constitution Check

*GATE: PASS. Re-checked after design: PASS.*

- **Architecture constraints**: Zotero remains the citation store; the bucket remains the
  reading store. The send uses the addon's write API. The app adds no metadata scraper and no
  citation database.
- **Stable URLs**: Reader pages stay at `/read/<key>` with citation tags; a PDF with no web URL
  goes to Zotero by its stable `/pdf/<key>.pdf` URL (`server/src/send.rs:136`).
- **Principle IV (failures)**: Every Zotero failure is a typed API error
  (`zotero_unavailable`, `zotero_failed`, `already_sent`, `pdf_only_refused`). The inspector
  shows its message. The open gaps are missing proofs, not success-shaped failures.
- **Principle II and Principle III**: A send that completes every owed step removes the item
  from the bucket, unless a Keep offline collection holds it. A failed send keeps the paper
  directory. The send does not change a kept paper's directory.
- **Development Workflow**: Each open behavioural task needs a failing focused test before
  the fix, and installed verification on port 8770 after the last runtime change.

## Project Structure

### Documentation (this feature)

```text
specs/006-zotero-transfer/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/send-api.md
└── tasks.md
```

### Source Code (repository root)

```text
server/src/
├── send.rs            # The three send routes, the owed-step model, one-PDF rule, item removal
├── zotero.rs          # Write API client: health check, import_from_url, attach, notes, trash, reads
├── extractions.rs     # extract_by_chain: the configured send extraction chain
├── error.rs           # AppError::Zotero to 502 zotero_failed
├── organization.rs    # set_zotero_record, kept_offline
├── state.rs           # zotero_status per item in the library payload
├── titles.rs          # Retrieve metadata: resolve_url only, which saves nothing
├── reader.rs          # Reader page with citation tags
└── guard.rs           # Cross-origin guard on state-changing routes
server/templates/reader.html  # citation_title, citation_author, citation_pdf_url
src/contract/library.ts       # ZoteroRecord, SendStep, SendResponse, SendAndExtractResponse, error kinds
src/web/
├── libraryActions.ts  # sendToZotero, SendWay, reportChain
├── commands.ts        # Command palette sends
├── Workspace.tsx      # Send wiring and per-item send attempt
└── components/
    ├── InspectorPanel.tsx   # Send button, Other sends menu, SendNotice
    └── ItemContextMenu.tsx  # Row and tab context menu sends
tests/
├── server-send.test.ts
├── server-send-live.ts
├── server-capture.test.ts
├── library-e2e.test.ts
└── fixtures/zotero/   # version.json, resolve-arxiv.json, resolve-unidentified.json
```

**Structure Decision**: Keep the current owners. `send.rs` stays the only Zotero writer.
Selected-collection targeting goes into `zotero.rs` and `send.rs`. New proofs use a
loopback stub of the write API in the Bun tests, the same method that
`tests/library-e2e.test.ts` already uses for `resolve_url`. The live suite stays opt-in.

## Design

### Send to Zotero (`POST /api/items/<key>/zotero`)

1. Refuse with `409 already_sent` when a record exists and no step is owed
   (`send.rs:348-356`). No Zotero request is sent.
2. Run the health check (`zotero.rs:308`). Failure gives `503 zotero_unavailable`.
3. Use the recorded Zotero item. When there is none, call `import_from_url` with the PDF
   URL and `store_attachments: false` (`send.rs:143-173`). Record the Zotero key at once
   (`send.rs:302`).
4. Perform each owed step and record it after Zotero answers (`send.rs:305-310`): `fields`,
   `pdf` (one PDF, `send.rs:200-219`), `markdown` when the paper has an extraction, and one
   `notes` step for each note.
5. Remove the item from the bucket unless a Keep offline collection holds it
   (`send.rs:332-338`).

A failure in step 4 leaves the record with the remaining steps owed. The next send uses the
same Zotero item and performs only those steps. That is the US2/AC2 retry path.

### Send to Zotero and Extract (`POST /api/items/<key>/zotero/extracted`)

Run the send steps first (`send.rs:395`). If the paper has no Markdown, run
`plugins.send_extraction_chain` up to the first success (`extractions.rs:380-391`). Then
perform the `markdown` step (`send.rs:400-407`). The answer lists each plugin outcome.
`reportChain` (`libraryActions.ts:611-623`) shows a notice for a success and an error report
when every plugin fails.

### Send PDF Only (`POST /api/items/<key>/zotero/pdf-only`)

Refuse when a record exists (`already_sent`) or when the item has notes or Markdown
(`pdf_only_refused`). Otherwise call `/attach` without `item_key`. The addon puts the
standalone attachment in the collection selected in Zotero, or in the library root when the
selected row is not a collection (addon `src/attach.ts`, `placeStandalone`).

### Required change: selected collection for Send to Zotero (FR-005)

`import_from_url` takes `collection_keys`, and the addon has `get_selected_collection`.
The bucket sends neither, so a new item goes to the library root. Read the selected
collection before the import and pass its key. When no collection is selected, use the
library root. That is what the addon already does for a standalone attachment. When no
Zotero window is open, the addon refuses with a conflict, and the send shows it as
`zotero_failed`. The send must also file an existing item it finds (`existing: true`) in
that collection. See [research.md](research.md) for the open question on this rule.

### Required proofs

- **Implicit writes**: Add a recording stub write API that answers `/version` as ready.
  Capture, read, extract and file a paper against it. Assert that it receives no operation
  other than `resolve_url` and no `/attach`.
- **Failures after item creation**: Use the same stub to fail `/attach` after
  `import_from_url`. Assert one Zotero item, the recorded key, `pending: ["pdf"]` and an
  intact local paper. Then let `/attach` succeed and assert exactly one PDF child and no
  second import.
- **All plugins fail**: Use a fixture chain where every plugin fails. Assert a PDF
  attachment, no Markdown attachment, the failed outcomes and the UI report.
- **UI visibility**: Click the inspector's send against a closed Zotero port and a refusing
  stub. Assert the `role="alert"` message, then open the paper.

## Risks / Recovery / Stop Rules

- Never point a tier-1 test at port 23119. The live suite writes to the user's library and
  runs only through `just test-zotero-live`.
- A stub must copy the addon's documented answers (`openapi.yaml` in the addon repository,
  or the recorded fixtures in `tests/fixtures/zotero/`). It must not invent fields.

## Decision Log

- Decision: Prove failure paths with a loopback stub of the write API, not with the live
  suite. Rationale: tier 1 must not mutate the user's library, and the live suite cannot
  force an attachment failure after item creation. Date: 2026-11-25.
- Decision: For Send to Zotero, use the library root when no collection is selected, as the
  addon does for standalone attachments. Rationale: both sends then behave the same way.
  Pending confirmation by the repository owner. Date: 2026-11-25.

## Complexity Tracking

No constitution violations.
