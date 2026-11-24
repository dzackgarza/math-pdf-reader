# Implementation Plan: Structured Extraction and Source Discovery

**Branch**: `004-extraction-source-discovery` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-extraction-source-discovery/spec.md`

## Summary

Make extraction source-aware and make arXiv discovery actionable. The server will
enforce provider eligibility and authoritative-output rules, while a confident arXiv
match will support an explicit promotion transition: the arXiv PDF replaces the
captured PDF under its existing key, captured provenance remains in historical
lineage, and recovery/extraction operate on the arXiv source. Filing and reading
state stay attached to the key. Promotion commits the replacement atomically.
The UI shows progress and the result of that action.

## Technical Context

**Language/Version**: Rust 2021 server, TypeScript 5.x web client, Python 3.14 extraction plugins

**Primary Dependencies**: Axum, reqwest, quick-xml, Zod, Bun/Vite, external extraction commands

**Storage**: Folder-backed PDF store with provenance embedded in PDFs, derived index export,
and filing/organization documents

**Testing**: Bun contract/integration tests, Rust unit tests, global QC recipes through just

**Target Platform**: Linux desktop app and its local HTTP server

**Project Type**: Desktop application with embedded web UI and local API

**Performance Goals**: Discovery and promotion must provide visible progress/failure;
provider execution remains bounded by configured download/plugin timeouts; the fixture
corpus must prove at least 95% known-match ranking and the UI must expose extraction
readiness/failure within 10 seconds after request completion

**Constraints**: Keep captured provenance as historical lineage. Ordinary
hash-safe recovery rejects changed bytes. The app uses no provider SDKs or
credentials and accepts no generic PDF text dump as an authoritative extraction.
Failures are explicit.

**Scale/Scope**: One local library per desktop installation; at most a small ranked
candidate set per discovery request; one historical source lineage per promoted paper;
at least 20 deterministic known-match discovery fixtures

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

* **Provenance**: PASS. The arXiv PDF carries its own embedded provenance. The captured
  URL, capture time, and original SHA-256 remain in historical lineage.
* **Authoritative extraction**: PASS. arXiv LaTeX remains authoritative for promoted arXiv
  items; non-arXiv items require a true OCR/document-structure provider.
* **Fail loudly**: PASS. Invalid candidates, unavailable providers, malformed source, and
  failed promotion produce explicit errors and no authoritative partial result.
* **Real-boundary tests**: PASS after the fixture-boundary design below is implemented.
  Production candidate validation remains restricted to HTTPS arXiv hosts; tests use a
  deterministic HTTP boundary that serves an arXiv-shaped fixture without weakening
  production validation.
* **Workflow**: PASS. Implementation uses failing focused tests first and repository
  just/QC recipes for validation.

## Project Structure

### Documentation

```text
specs/004-extraction-source-discovery/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── source-discovery-api.md
└── tasks.md
```

### Source Code

```text
server/src/
├── arxiv.rs
├── extractions.rs
├── imports.rs
├── organization.rs
├── source_routes.rs
├── store.rs
└── contract.rs
src/contract/
├── extraction.ts
└── library.ts
src/web/
├── Workspace.tsx
├── libraryActions.ts
└── components/
    ├── ExtractionRunner.tsx
    └── InspectorPanel.tsx
plugins/manifests/extractions.json
tests/
├── server-extractions.test.ts
├── server-sources.test.ts
├── capture-contract.test.ts
└── fixtures/
```

**Structure Decision**: Extend the existing Rust local server, shared Zod/Rust contracts,
React inspector/extraction controls, manifest-driven plugins, and Bun integration fixtures.
No new service or storage subsystem is introduced.

## Required State Transition

Promotion has one durable lineage record:

```text
captured paper (PDF, original URL and hash, filing, reading state)
  -> candidate selected (confidence >= 0.80)
  -> source fetched and verified as an arXiv PDF
  -> replacement PDF and provenance staged under the existing key
  -> document directory exchanged atomically
  -> old PDF and extraction retired from the active store
```

The lineage contains `originalKey`, `originalProvenance`, `preferredKey`,
`discoveredSourceUrl`, and `promotedAt`. Both key fields name the same paper.
The current arXiv PDF embeds that lineage. Repeated promotion for the same
identifier/version returns the existing key. Recovery starts with the arXiv URL.
A failed promotion leaves the captured PDF and its extraction in place. An arXiv
PDF whose original bytes already belong to a different stored key causes a
conflict; the app does not merge independent filing records.

## Fixture Boundary

The arXiv client receives a configurable API and PDF base URL in tests only. The
production configuration is fixed to HTTPS `export.arxiv.org`/`arxiv.org` hosts.
Fixture tests serve Atom metadata and a real PDF from a local HTTP publisher while
asserting that a production-style candidate with a non-arXiv host is rejected.

## Archive Contract

The arXiv source provider accepts an arXiv identifier/version, downloads the `e-print`
archive, validates that the archive is readable and contains source files, and writes:

1. the original archive as the authoritative source artifact;
2. one readable Markdown file converted from the main LaTeX document and its includes;
3. no authoritative result when retrieval, archive validation, or conversion fails.

## Complexity Tracking

| Violation in the source | Principle | Owning task |
| --- | --- | --- |
| The index gives an extraction directory without `metadata.json` a silent `document_structure`, non-authoritative default (`server/src/index.rs`). | IV. Fail Loudly | T065 |
| The page-to-extraction mapping code is still in the tree with no caller (`Store::locate`, `src/pdfbucket/locate.py`). | III. Reader Context Is Minimal and Explicit | T066 |
