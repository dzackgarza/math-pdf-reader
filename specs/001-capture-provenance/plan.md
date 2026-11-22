# Implementation Plan: PDF Capture and Provenance

**Branch**: `001-capture-provenance` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-capture-provenance/spec.md`

## Summary

Implement the complete browser-to-library capture path for Chrome and Firefox:
identify eligible PDF GET navigations with the shared response predicate, preserve
the original bytes and embedded provenance, open the resulting reader URL, surface
failures with a native-open action, and recover missing PDFs from the original URL
before mirrors. The existing split architecture remains: TypeScript extensions
intercept browser traffic, the Rust/Axum server owns capture and recovery, and the
Tauri desktop shell follows reader-open events.

## Technical Context

**Language/Version**: Rust (workspace MSRV from `Cargo.toml`), TypeScript with Bun,
Python 3.14 for existing store tooling

**Primary Dependencies**: Axum/Tokio server, Tauri 2 desktop shell, WXT browser
extensions, Zod shared contracts, pikepdf-backed provenance helpers

**Storage**: Folder-backed PDF store with provenance embedded in PDF document
metadata and a derived index export

**Testing**: Bun tests for extension/server contracts and integration behavior,
Rust tests where applicable, Python provenance tests, browser fixture tests, and
repository `just` QC gates

**Target Platform**: Linux desktop (Tauri/WebKit), Chrome MV3 (Chrome 128+), and
Firefox browser extension

**Project Type**: Desktop application with local HTTP server and two browser
capture integrations

**Performance Goals**: Capture must return a reader URL after bytes are durably
stored; status and event paths remain responsive for one active local capture.
Responsiveness is a qualitative, non-gating goal for the existing local desktop
workload; the feature defines no latency or throughput threshold.

**Constraints**: GET-only document interception; POST, small embedded frames, and
the bucket origin are excluded. Chrome cannot read navigation bodies directly and
must use a download handoff; Firefox streams the response body. Failures must be
visible and must not silently fall back or discard the local PDF. Reader-window
focus validation is limited to Wayland; other desktop sessions are out of scope
for focus behavior.

**Scale/Scope**: One local user, one folder-backed store, two browser integrations,
and bounded source/mirror lists per paper.

## Constitution Check

*GATE: PASS*

- **Provenance**: capture stores source URL, capture time, and original SHA-256
  inside the PDF; index data remains derived.
- **Fail loudly**: capture, recovery, and focus failures remain visible; no
  low-fidelity or partial result becomes a success-shaped capture.
- **Stable URLs**: every successful capture returns a stable local reader URL.
- **Tests at boundaries**: tests exercise extension/server boundaries, recovery
  ordering, embedded provenance, visible capture failures, and desktop focus status.
- **Focus boundary**: Wayland capture tests must either focus the reader or report
  an actionable focus failure; non-Wayland focus behavior is out of scope.
- **Architecture ownership**: extensions intercept, server stores and recovers,
  Tauri follows events; no new viewer or citation store is introduced.

## Project Structure

### Documentation (this feature)

```text
specs/001-capture-provenance/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── capture-api.md
    └── browser-capture.md
```

### Source Code (repository root)

```text
server/src/
├── app.rs
├── store.rs
├── sources.rs
├── source_routes.rs
└── events.rs

src/contract/
└── capture.ts

src/extension/
├── interception.ts
├── firefox-interception.ts
├── capture.ts
└── entrypoints/
    ├── background.ts
    ├── capture/main.ts
    └── popup/main.ts

desktop/src-tauri/
└── src/follow-open-events.js

tests/
├── capture-e2e.test.ts
├── capture-contract.test.ts
├── capture-helpers.ts
├── desktop_workflow.py
├── interception.test.ts
├── server-sources.test.ts
├── server-capture.test.ts
├── extension-manifest.test.ts
└── fixtures/
    ├── README.md
    ├── capture-cases.ts
    └── recovery-cases.ts
```

**Structure Decision**: Preserve the existing split runtime and shared-contract
boundary. Add or extend focused tests beside the current extension, server, and
source-recovery tests; do not introduce a second capture pipeline or a new storage
format.

## Complexity Tracking

No constitution violations. The final runtime verification uses the normal launcher
and does not require manual provisioning.
