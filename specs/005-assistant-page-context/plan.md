# Implementation Plan: Assistant Paper Sources and Page Context

**Branch**: `005-assistant-page-context` | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-assistant-page-context/spec.md`

## Summary

Every stored PDF has an assistant session, regardless of extraction state. The bucket
serves bounded text from one requested raw-PDF page and gives the private OpenCode
agent that address and the exact reader page. New and existing sessions use the paper's
document directory. The agent discovers the original PDF, extractions and other paper
artifacts there with read-only generic tools. An extraction placed after a session
opens needs no refresh. The assistant has no shell, filesystem-edit or sub-agent
capability.

## Technical Context

**Language/Version**: Rust (edition 2024), TypeScript/Bun, Python 3 with PyMuPDF

**Primary Dependencies**: Axum, OpenCode, React, EmbedPDF, PyMuPDF, Zod

**Storage**: Stored PDFs, extraction files and OpenCode session state on the local
filesystem

**Testing**: Bun real-HTTP server tests, one real-provider live regression, focused
Rust compile checks, existing desktop/browser gates

**Target Platform**: The user's Linux desktop application and its loopback HTTP servers

**Project Type**: Desktop application with loopback web services

**Performance Goals**: No separate target; a paper-text response is bounded to one PDF
page

**Constraints**: No shell or arbitrary web access for the assistant; no direct PDF
attachment dependency; no approximate page-to-extraction mapping; no pseudo-extraction
stored for raw PDF text

**Scale/Scope**: One chat per stored PDF and one requested page per raw-text response

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Provenance**: PASS. The feature reads the stored PDF and does not change its
  embedded provenance.
- **II. Raw PDF Access and Authoritative Extractions**: PASS. Raw text is always
  available; an authoritative extraction is additional context, never synthesized from
  generic PDF text.
- **III. One Document Directory and Page Context**: PASS. The instruction entry
  carries the exact page and raw-page address. All paper artifacts share the session's
  document directory without a generated catalog.
- **IV. Fail Loudly**: PASS. Invalid raw-page requests retain explicit errors;
  extraction failure does not disable raw-PDF answers.
- **V. Real-Boundary Tests**: PASS. Tests use real bucket and extraction boundaries,
  select a non-first page, and exercise the configured provider in the live test.

Post-design result: PASS. The contracts and validation scenarios introduce no
additional storage, provider or permission exception.

## Project Structure

### Documentation (this feature)

```text
specs/005-assistant-page-context/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── assistant-api.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
server/src/
├── ai.rs                 # Directory sessions, permissions and raw-page routes
└── extractions.rs        # Placement in the paper's document directory
src/pdfbucket/text.py     # One-page text from the stored PDF
src/web/AiPane.tsx        # Assistant pane and extraction status
src/contract/             # API and extraction schemas
tests/
├── server-ai.test.ts     # Real bucket and assistant-server boundaries
├── server-ai-live.ts     # Real configured-provider regression
└── fixtures/             # PDF and extraction-plugin fixtures
```

**Structure Decision**: Extend the existing assistant and extraction modules. The
bucket owns page-context generation and stable session location. The document directory
owns artifact discovery, so extraction callers need no assistant refresh. The UI remains
a consumer of the existing session API.

## Complexity Tracking

No constitution violations.
