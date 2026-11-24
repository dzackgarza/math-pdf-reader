# Implementation Plan: Assistant Document Directory

> Tier: implementation-adjacent
> Parent plan: `PLAN-PDF-BUCKET-ROADMAP` under `FEATURE-PDF-BUCKET`
> Externalized fit: existing roadmap issue tree; no new issue or PR is claimed.
> Modeling prerequisite: [type-system-prepass.md](type-system-prepass.md)

**Branch**: `009-assistant-document-directory` (Spec Kit identifier; delivery stays on
`main`) | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

## Summary

Replace the flat paper layout and synthetic assistant workspaces with one directory per
paper. Migrate existing files by rename, point new and existing OpenCode chats at that
directory, and let the assistant inspect the original and its enrichment using its own tools.

## Technical Context

**Language/Version**: Rust edition 2021, TypeScript/Bun, Python 3 with PyMuPDF

**Primary Dependencies**: Axum, Tokio, OpenCode session APIs, Zod, existing extraction
commands

**Storage**: Local document directories and OpenCode's private session store

**Testing**: Real-HTTP Bun regressions, focused Rust checks, real-provider live test,
provisioned app verification

**Target Platform**: The user's Linux desktop app and loopback servers

**Project Type**: Desktop application with local file storage and web services

**Performance Goals**: No new target; startup migration uses same-filesystem renames

**Constraints**: Preserve embedded provenance, bytes, keys and stable URLs; raw PDF
availability never depends on extraction; shell tools operate from the document directory; no dual-layout fallback or source-catalog regeneration

**Scale/Scope**: All store lifecycle paths, all current user papers and one chat per paper

## Constitution Check

Constitution 4.0 requires the stored PDF, directory discovery with shell access, and
page hints used only for correlation. The [task list](tasks.md) covers
runtime changes and provisioned verification.

## Project Structure

```text
specs/009-assistant-document-directory/
├── spec.md
├── type-system-prepass.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/assistant-api.md
└── tasks.md

server/src/
├── layout.rs       # Document paths and flat-layout migration
├── store.rs        # Capture, replacement, extraction and deletion writes
├── index.rs        # Document-directory scanning and unreadable originals
├── ai.rs           # Session location/move, tool permissions and page hints
├── extractions.rs  # No assistant source-catalog refresh
├── send.rs         # Zotero attachment reads through the shared layout
├── lib.rs          # Migration before serving
└── main.rs         # Migration before maintenance commands
tests/
├── server-document-directory.test.ts
├── server-ai.test.ts
├── server-ai-live.ts
├── server-extractions.test.ts
└── store.ts
```

**Structure Decision**: Extend the current owners. `layout.rs` remains the only source
of paper paths. OpenCode remains the session store and UI. No new storage service or
assistant abstraction is added.

## Task Plan

### Prove and implement the document-directory store

- **Obligation**: FR-001, FR-008 through FR-012.
- **Preconditions**: This pre-pass; current flat-layout behavior captured by a failing
  real-HTTP regression.
- **Change**: Introduce document paths and resumable non-overwriting migration; move all
  producers, readers and deletion to those paths.
- **Acceptance**: Every lifecycle operation preserves identity and provenance; unknown
  artifacts travel with deletion; no flat current copy remains.
- **Proof**: Focused document, extraction, library, source, send and export tests, plus
  `cargo check --package pdf-bucket`.
- **Commit boundary**: Failing regression first; directory storage and migration second.

## Design

OpenCode owns file discovery, tool choice and reading. The bucket sets the session
location and updates the displayed page number when the reader reports it. A short
text-layer snippet can help locate the passage in a complete extraction. The
assistant checks the passage against a paper artifact.

## Implementation owners

- `server/src/ai.rs` owns session location, tool permissions and reader context.
- Extraction commands place their completed files through the store's existing
  extraction contract. See [source discovery](../004-extraction-source-discovery/spec.md).
- `tests/server-ai.test.ts` and `tests/server-ai-live.ts` exercise the HTTP and
  provider boundaries. The [validation guide](quickstart.md) specifies the
  required observations.

## Risks / Recovery / Stop Rules

- Migration collision: stop startup, preserve both paths and report the exact conflict;
  never choose or merge silently.
- OpenCode move failure: surface `ai_unavailable`; never reuse the old location as if it
  were correct.
- Permission failure: inspect the session location and the actual tool result.
- Provider failure: distinguish provider availability from read/discovery failure.
- Stop for a user decision only if preservation would require deleting or merging two
  different current paper artifacts.

## Decision Log

- Decision: Keep key-based file names inside `<root>/<key>/`.
  Rationale: One directory changes ownership without changing public artifact names.
  Date/author: 2026-11-24, implementation planning from the user's requirement.
- Decision: Migrate legacy paths at every entry point before indexing or serving.
  Rationale: The installed app and maintenance commands must see one layout only.
  Date/author: 2026-11-24.

## Revision Notes

- 2026-11-24: Initial design after replacing endpoint-driven paper-source handling
  with document-directory discovery.
