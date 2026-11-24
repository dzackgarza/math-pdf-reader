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
directory, let the model discover current enrichment, and retain only the raw-page HTTP
adapter needed by models that cannot consume PDFs.

## Technical Context

**Language/Version**: Rust edition 2024, TypeScript/Bun, Python 3 with PyMuPDF

**Primary Dependencies**: Axum, Tokio, OpenCode session APIs, Zod, existing extraction
commands

**Storage**: Local document directories and OpenCode's private session store

**Testing**: Real-HTTP Bun regressions, focused Rust checks, real-provider live test,
provisioned app verification

**Target Platform**: The user's Linux desktop app and loopback servers

**Project Type**: Desktop application with local file storage and web services

**Performance Goals**: No new target; startup migration uses same-filesystem renames

**Constraints**: Preserve embedded provenance, bytes, keys and stable URLs; raw PDF
availability never depends on extraction; no shell/edit/subagent or arbitrary-web
capability; no dual-layout fallback or source-catalog regeneration

**Scale/Scope**: All store lifecycle paths, all current user papers and one chat per paper

## Constitution Check

- **I. Provenance**: PASS. Migration and writes rename bytes without replacing embedded
  provenance; item URLs retain keys.
- **II. Raw PDF and extraction**: PASS. Raw-page access remains independent and complete
  extractions remain enrichment, including authoritative LaTeX.
- **III. One directory and page context**: PASS after the v3.0.0 amendment. Sessions
  occupy the document directory, exact page context remains, and no source catalog is
  generated.
- **IV. Fail loudly**: PASS. Migration collisions and invalid originals fail explicitly;
  incomplete staging is invisible as complete extraction.
- **V. Real-boundary tests**: PASS. Tests exercise store HTTP, private OpenCode and the
  real provider, then the provisioned app on port 8770.

Post-design result: PASS. No fallback, synthetic extraction or weakened proof is present.

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
├── ai.rs           # Session location/move, discovery permissions and raw pages
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

### Put the assistant in the paper directory

- **Obligation**: FR-002 through FR-007 and Constitution III.
- **Preconditions**: Document-directory store; failing session-location regression.
- **Change**: Create chats in and move existing chats to the directory. Replace generated
  catalogs with generic discovery instructions and root-wide read-only glob/grep/read
  permissions. Retain raw-page and exact-page routes; remove extraction-text and refresh.
- **Acceptance**: One session ID survives movement; arbitrary current files need no new
  instructions or endpoint; raw-only and enriched papers use the same mechanism.
- **Proof**: Private-server HTTP regressions, real-provider live discovery, focused
  assistant tests.
- **Commit boundary**: Failing assistant regressions first; assistant migration second.

### Align contracts and evidence, then provision

- **Obligation**: Current documentation and user-visible proof.
- **Change**: Amend 005 and 009 records, roadmap Decision Log, README and M4 paths and
  behavior; provision and inspect the migrated store and assistant.
- **Acceptance**: No current document prescribes the synthetic workspace or extraction
  endpoint. Port 8770 demonstrates raw-only and same-chat unknown-artifact discovery.
- **Proof**: Focused checks, `just provision`, direct HTTP/OpenCode observations and
  filesystem inspection.
- **Commit boundary**: Documentation/evidence and verified install, then final delivery.

## System-Level Validation

- Real store: migration preserves byte hashes and readable provenance; extraction and
  annotation behavior remain intact.
- Real OpenCode: create/move and permissions are observed through its HTTP API.
- Real provider: answers require raw page 2 and an unregistered artifact added after
  session creation.
- Installed app: existing user data migrates and port 8770 demonstrates both source modes.

## Risks / Recovery / Stop Rules

- Migration collision: stop startup, preserve both paths and report the exact conflict;
  never choose or merge silently.
- OpenCode move failure: surface `ai_unavailable`; never reuse the old location as if it
  were correct.
- Permission failure: inspect the generated rules and real tool error; do not enable
  shell or broaden access beyond the store.
- Provider failure: distinguish provider availability from read/discovery failure.
- Stop for a user decision only if preservation would require deleting or merging two
  different current paper artifacts.

## Progress

- [ ] Store regressions and implementation -- real lifecycle evidence required.
- [ ] Assistant regressions and implementation -- session and live discovery evidence.
- [ ] Documents, roadmap, provisioned verification -- current behavior on port 8770.

## Surprises & Discoveries

- Observation: OpenCode already supports session location and session move.
  Evidence: official `/api/session` and `/api/session/{id}/move` schemas.
  Consequence: old chats need no replacement or synthetic-workspace symlink.
- Observation: the configured model cannot consume PDF input.
  Evidence: prior live provider failure recorded in 005 documents.
  Consequence: only the bounded raw-page HTTP adapter remains.

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
