---

description: "Task list for source-aware extraction and arXiv source promotion"
---

# Tasks: Structured Extraction and Source Discovery

**Input**: Design documents from `/specs/004-extraction-source-discovery/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`,
`contracts/source-discovery-api.md`, and `quickstart.md`.

**Tests**: Required by the constitution and the feature success criteria. Each focused
test must be written first, observed failing, then made green by the smallest implementation.

## Phase 1: Setup

**Purpose**: Establish the shared contract and fixture surfaces used by all stories.

- [X] T001 [P] Add source-discovery API schemas and types to `src/contract/library.ts`
- [X] T002 [P] Add source-lineage and authoritative-extraction fields to the shared contract in `src/contract/library.ts`
- [X] T003 [P] Add source-discovery fixture metadata and real PDF/source fixtures under `tests/fixtures/`
- [X] T004 Document the source-discovery API and promotion state transition in `specs/004-extraction-source-discovery/contracts/source-discovery-api.md`

## Phase 2: Foundational

**Purpose**: Build the shared persistence and eligibility primitives that block all three
stories.

- [X] T005 Extend the organization document model in `server/src/organization.rs` to persist original-item, preferred-item, discovered-source, and promotion timestamp lineage without mutating embedded original provenance
- [X] T006 Add generated Rust contract registrations in `server/src/contract.rs` for source candidates, promotion requests/responses, lineage, and authoritative extraction state
- [X] T007 Add explicit authoritative/source-kind state to extraction records in `server/src/extractions.rs` and `src/contract/extraction.ts`
- [X] T008 Add fixture-backed helpers in `tests/store.ts` and `tests/capture-helpers.ts` for reading embedded provenance and asserting linked library items
- [X] T009 [P] Add invalid-input error cases and source-host validation helpers in `server/src/error.rs` and `server/src/arxiv.rs`
- [X] T009a [P] Add test-only configurable Atom/PDF endpoints and deterministic arXiv-shaped fixtures while keeping production host validation strict in `server/src/arxiv.rs` and `tests/fixtures/`

**Checkpoint**: Shared contracts, lineage persistence, extraction authority, and real fixture
helpers are ready before story work begins.

## Phase 3: User Story 1 - Run an eligible extraction (Priority: P1) 🎯 MVP

**Goal**: Only eligible providers can run, successful source-backed output is visibly
authoritative, and failures never become authoritative extraction.

**Independent Test**: Run each provider against eligible and ineligible fixture items through
the real extraction API, then inspect the returned library state and stored artifacts.

### Tests for User Story 1

- [X] T010 [P] [US1] Add contract tests for extraction eligibility and authoritative status in `tests/extraction.test.ts`
- [X] T011 [P] [US1] Add integration tests for provider failure, partial-output cleanup, and non-authoritative state in `tests/server-extractions.test.ts`
- [X] T012 [P] [US1] Add manifest contract tests rejecting generic full-document PDF text providers in `tests/manifests.test.ts`

### Implementation for User Story 1

- [X] T013 [P] [US1] Define provider input/output and source-eligibility fields in `plugins/manifests/extractions.json`
- [X] T014 [US1] Enforce manifest eligibility and reject ineligible providers before process launch in `server/src/extractions.rs`
- [X] T015 [US1] Expose only eligible providers and visible failure/authoritative state in `src/web/components/ExtractionRunner.tsx`
- [X] T016 [US1] Store successful provider artifacts with explicit authoritative/source-kind state and remove or quarantine invalid partial output in `server/src/store.rs`
- [X] T017 [US1] Verify extraction API responses and library payloads contain the authoritative state in `src/contract/extraction.ts` and `src/contract/library.ts`

**Checkpoint**: User Story 1 is independently testable: eligible extraction succeeds visibly,
ineligible extraction is rejected/hidden, and failures cannot masquerade as authoritative output.

## Phase 4: User Story 2 - Discover and promote an arXiv version (Priority: P1)

**Goal**: A confident arXiv match is not merely displayed; the user can explicitly promote
the equivalent arXiv item, use it as the preferred working source, and retain the original
capture and provenance.

**Independent Test**: Capture a non-arXiv fixture, discover a confident candidate, promote it,
then verify the library contains the promoted preferred item, unchanged original item,
durable lineage, arXiv eligibility, and preserved embedded provenance.

### Tests for User Story 2

- [X] T018 [P] [US2] Add scoring tests for exact metadata, near matches, incomplete metadata, and no-match candidates in `server/src/arxiv.rs`
- [X] T019 [P] [US2] Add API contract tests for ranked candidates, visible threshold, malformed candidates, low-confidence candidates, and non-ArXiv URLs in `tests/server-sources.test.ts`
- [X] T020 [US2] Add an end-to-end promotion test using a real local source fixture that verifies the promoted item, original item, lineage, embedded provenance, and arXiv eligibility in `tests/server-sources.test.ts`
- [X] T021 [US2] Add a failure-path integration test proving failed fetch, invalid PDF, or persistence failure leaves the original item usable and reports an explicit error in `tests/server-sources.test.ts`
- [X] T021a [US2] Add idempotency and atomicity tests proving repeated promotion reuses the preferred item and failed metadata/lineage persistence leaves no unlinked item
  - Evidence (source): `tests/server-sources.test.ts` covers repeat promotion (`confident arXiv promotion preserves the original and is idempotent`, `simultaneous promotions from separate server processes reuse one preferred item`, `repeating promotion of a missing preferred item does not create a duplicate`) and failed persistence (`metadata recording failure rolls back a newly captured preferred PDF`, `lineage persistence failure never publishes a preferred PDF`).

### Implementation for User Story 2

- [X] T022 [P] [US2] Implement deterministic arXiv candidate search, confidence thresholding, and candidate contracts in `server/src/arxiv.rs`
- [X] T023 [US2] Implement server-side candidate validation and source fetch verification for `POST /api/items/{key}/arxiv/promote` in `server/src/arxiv.rs` and `server/src/imports.rs`
- [X] T024 [US2] Implement safe promoted-item capture/linkage in `server/src/store.rs` and `server/src/organization.rs` without changing the original item's embedded provenance or ordinary hash-safe recovery
  - Evidence (source): `Store::capture_distinct` in `server/src/store.rs` places the preferred item with its lineage; `promote` in `server/src/arxiv.rs` checks the original's provenance again under the filing lock before placement.
- [X] T025 [US2] Expose promotion response and lineage state through `server/src/app.rs`, `server/src/state.rs`, and `src/contract/library.ts`
- [X] T025a [US2] Make both original and preferred items expose the same source lineage and make the preferred item the sole selected representation in library state
- [X] T026 [US2] Add browser actions for candidate search and explicit promotion/replacement in `src/web/libraryActions.ts`
- [X] T027 [US2] Add candidate promotion controls, progress, failure, success, and original-preserved messaging in `src/web/components/InspectorPanel.tsx`
- [X] T028 [US2] Refresh library state and select the promoted preferred item without deleting the original in `src/web/Workspace.tsx`
- [X] T028a [US2] Make repeated promotion return/select the existing preferred item instead of creating a duplicate
- [X] T028b [US2] Add visible progress, completion, and failure timing assertions for the 10-second readiness criterion

**Checkpoint**: User Story 2 is independently testable through the UI-facing API and proves
SC-006, not merely candidate ranking.

## Phase 5: User Story 3 - Use arXiv source artifacts or true OCR (Priority: P1)

**Goal**: Promoted arXiv items use LaTeX source as authoritative extraction; non-arXiv items
use only configured true OCR/document-structure providers; generic PDF text is never accepted.

**Independent Test**: Run source extraction on a promoted arXiv fixture and a non-arXiv fixture,
then inspect the stored authoritative artifacts and failure behavior.

### Tests for User Story 3

- [X] T029 [P] [US3] Add a source-backed arXiv extraction integration test that checks the stored LaTeX artifact and authoritative marker in `tests/server-extractions.test.ts`
- [X] T030 [P] [US3] Add a true-OCR/document-structure fixture test for non-arXiv extraction in `tests/server-extractions.test.ts`
- [X] T031 [US3] Add malformed/missing-source tests proving no PDF-text substitution is stored or selected in `tests/server-extractions.test.ts`

### Implementation for User Story 3

- [X] T032 [P] [US3] Implement arXiv source retrieval, archive validation, and LaTeX artifact storage in the declared extraction command and `server/src/extractions.rs`
- [X] T033 [US3] Enforce promoted-source eligibility when selecting the arXiv LaTeX provider in `server/src/extractions.rs` and `src/web/components/ExtractionRunner.tsx`
- [X] T034 [US3] Configure non-arXiv OCR/document-structure providers and reject generic PDF text output in `plugins/manifests/extractions.json`
- [X] T035 [US3] Mark derived Markdown as convenience output and expose the source artifact/authoritative state to assistant context in `server/src/ai.rs` and `src/contract/extraction.ts`
- [X] T035a [US3] Add archive-level tests for readable source archives, missing/malformed source, authoritative source artifact, and derived Markdown

**Checkpoint**: User Story 3 is independently testable and proves the source hierarchy
required by FR-008 through FR-010.

## Phase 6: Polish and Cross-Cutting Validation

- [X] T036 [P] Update `specs/004-extraction-source-discovery/quickstart.md` with the final promotion and extraction commands
- [X] T037 [P] Add user-facing source/provenance and promotion wording to `README.md` and relevant UI copy
- [X] T038 Run `git diff --check` and the focused Bun/Rust tests from `specs/004-extraction-source-discovery/quickstart.md`
  - Discharged by T061.
- [X] T039 Run `just test-commit` and the applicable Rust/QC recipes; record any repository-wide pre-existing failures without weakening this feature's checks
  - Discharged locally by T061. Push QC in CI fails in setup; see T071.
- [X] T040 Verify user-visible behavior through the normal launcher; do not run manual provisioning
  - Discharged by T062.
- [X] T041 Assert the 20-fixture discovery corpus meets the 95% known-match ranking criterion

## Phase 7: Convergence

- [X] T042 Add failure-injection tests proving metadata and lineage persistence rollback removes any newly promoted item while preserving the original per FR-014 (partial)
- [X] T043 Add a UI-facing timing test proving extraction readiness or failure is visible within 10 seconds after completion per SC-004 (missing)
- [X] T044 Add a server extraction integration test that runs the arXiv provider against a deterministic source fixture and verifies the authoritative LaTeX artifact per FR-008 (missing)
- [X] T045 Add a server extraction fixture test for a true OCR or document-structure provider on a non-arXiv item per FR-009 (missing)
- [X] T046 Add server integration coverage proving malformed or missing arXiv source leaves no authoritative or PDF-text substitute result per FR-010 and T031 (partial)
- [X] T047 Preserve the original downloaded arXiv e-print archive as the authoritative source artifact while retaining derived Markdown as convenience output per the plan Archive Contract (partial)
- [X] T048 Verify user-visible behavior through the normal launcher and record the result without manual provisioning per T040 and the constitution Development Workflow (missing)
  - Discharged by T062.
- [X] T049 Add the deterministic 20-paper discovery corpus and assert at least 95% known-match ranking per SC-002 and T041 (missing)
- [X] T050 Remove approximate page-to-extraction mapping from assistant context and expose only exact reader page context plus an authoritative-extraction pointer per Constitution III (contradicts)

## Phase 8: Convergence

- [X] T051 Complete atomic promotion failure-injection coverage and prove rollback preserves the original item per T042, FR-014 (partial)
  - Evidence (source): each FR-014 step has a failure test in `tests/server-sources.test.ts`: source fetch (`a failed preferred-source fetch leaves the original item usable`), PDF placement (`promotion does not overwrite or remove a PDF placed by another writer`), metadata (`metadata recording failure rolls back a newly captured preferred PDF`, `a metadata failure never publishes the preferred PDF`), and lineage (`lineage persistence failure never publishes a preferred PDF`).
- [X] T052 Complete the UI extraction readiness/failure timing assertion within 10 seconds per T043, SC-004 (missing)
- [X] T053 Complete server-boundary arXiv extraction coverage with an authoritative source artifact per T044, FR-008 (missing)
- [X] T054 Complete server-boundary true OCR/document-structure fixture coverage for non-arXiv items per T045, FR-009 (missing)
- [X] T055 Complete malformed/missing-source integration coverage proving no authoritative PDF-text fallback per T046, FR-010 (partial)
- [X] T056 Complete preservation of the original downloaded e-print archive as the authoritative artifact per T047 and the plan Archive Contract (partial)
- [X] T057 Complete normal-launcher runtime verification without manual provisioning per T048 and the constitution Development Workflow (missing)
  - Discharged by T062.
- [X] T058 Complete the deterministic 20-paper corpus and 95% ranking assertion per T049, SC-002 (missing)
- [X] T059 CRITICAL: Remove approximate page-to-extraction mapping from assistant context and expose only exact page context plus the authoritative-extraction pointer per T050 and Constitution III (contradicts)

## Dependencies and Execution Order

### Phase Dependencies

- Setup (Phase 1) precedes Foundational (Phase 2).
- Foundational (Phase 2) blocks all user stories.
- User Stories 1 and 2 can proceed in parallel after Phase 2.
- User Story 3 depends on User Story 2's promotion lineage and eligibility state.
- Recovery work in T024/T025 also updates `server/src/sources.rs` and `server/src/export.rs` so preferred-source recovery is explicit; original recovery remains hash-safe.
- Polish (Phase 6) follows the desired user stories.

### User Story Dependencies

- **US1**: Independent after Phase 2.
- **US2**: Independent after Phase 2; reuses shared contracts and storage primitives.
- **US3**: Depends on US2 for promoted arXiv provenance and source eligibility.

### Parallel Opportunities

- T001–T004 can run in parallel.
- T009 can run in parallel with T005–T008.
- T010–T012 can run in parallel before US1 implementation.
- T018–T019 can run in parallel before US2 implementation; T020–T021 follow the promotion
  contract and must fail before implementation.
- T022 and the UI contract preparation T026 can proceed in parallel once T019 is defined.
- T029–T031 can run in parallel before US3 implementation.

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases.
2. Complete US1 so extraction eligibility and authority are trustworthy.
3. Complete US2 so discovery has a real preferred-source promotion path.
4. Validate US1 and US2 independently before starting US3.

### Incremental Delivery

1. Source-aware extraction and failure semantics.
2. Search plus explicit arXiv promotion with preserved original provenance.
3. Authoritative LaTeX/OCR artifact handling.
4. Cross-cutting runtime and QC validation.

### TDD Requirement

For every story, write the focused contract/integration test first, run it to observe the
expected failure, implement the smallest behavior that passes, then run the story checkpoint
and repository QC.

## Phase 9: Convergence

- [X] T060 Add the required `source_kind` and `authoritative` fields to the plugin fixture in `tests/extraction.test.ts` so the eligibility contract test passes per T010, FR-001, and SC-001 (partial)
- [X] T061 Guard `null` from `readIndexExport` in `tests/server-sources.test.ts` so `tsc` and `just test-commit` pass, then rerun the focused checks and `just test-commit` per T038, T039, and the constitution Development Workflow (partial)
- [X] T062 Start the app through `scripts/launch` (the normal launcher; no manual provisioning), verify on port 8770 that arXiv search shows the 0.80 threshold, promotion creates a distinct preferred item while preserving the original, and arXiv source extraction produces the authoritative source artifact, then record the result per T040, T048, T057, and the constitution Development Workflow (missing)
  - Result (source fingerprint matched the checkout after `scripts/launch` rebuilt): search on `07410103` returned `threshold: 0.80` with one match `1212.1675` at score `1.0`; promotion created a distinct preferred item `1212.1675v3` holding `sourceLineage` to `07410103`, and the original stayed in the library; extraction on `1111.3209v4` (`POST /api/items/1111.3209v4/extractions/arxiv-source`) succeeded with `source_kind: arxiv_latex`, `authoritative: true`, and artifacts `source.eprint` and `source.tex`. Two defects surfaced and are recorded as T063 and T064.
- [X] T063 Notify the index exporter when an extraction is placed, so the export carries the extraction's `sourceKind` and `authoritative` instead of a stale record, proven by a test that fails before the fix and passes after per FR-008, FR-011, and the plan Archive Contract (missing; found by T062)
- [ ] T064 Neutralize the `\input`/`\include` targets an arXiv source package does not ship before `latexpand` flattens it, so a paper whose source pulls in a system package (for example `\input{xy}` for xypic) converts instead of failing per the plan Archive Contract conversion-failure path (partial; found by T062)

## Phase 10: Convergence

- [ ] T065 Report an extraction directory without `metadata.json` as an explicit unlabelled extraction state in `server/src/index.rs`, the library contract and `src/web/components/ExtractionRunner.tsx`, so the user re-runs the extraction. The index now gives such a directory a silent `document_structure`, non-authoritative default. Per Constitution IV and FR-011 (contradicts). In the running app, the arXiv LaTeX extraction of `1508.07880v1` shows as `document_structure`, not authoritative, and the assistant gets no extraction for it.
- [ ] T066 Delete the page-to-extraction mapping that T059 left with no caller: `Store::locate` and `ExtractionLines` in `server/src/store.rs`, `src/pdfbucket/locate.py`, the `locate` command in `src/pdfbucket/cli.py`, and `tests/test_locate.py`, per Constitution III and T059 (partial).
- [ ] T067 Compare authors by normalized name (surname and initials, with case and diacritics folded) in `author_similarity` in `server/src/arxiv.rs`, so "J. Kollár" matches "János Kollár". The exact full-string comparison gives abbreviated captured authors a score of zero, which keeps an exact-title match below the 0.80 threshold. Per FR-004 and the edge case "Metadata may be incomplete" (partial).
- [ ] T068 Query arXiv by title terms instead of the exact phrase `ti:"<title>"` in `search_candidates` in `server/src/arxiv.rs`, and rank the candidates locally, so a captured title that differs in TeX markup, punctuation or subtitle still returns candidates, per FR-004 and the edge case "unusual mathematical notation" (partial).
- [ ] T069 Make the SC-002 corpus test in `tests/server-sources.test.ts` use captured-style metadata (abbreviated, reordered or missing authors, TeX in titles, changed subtitles) and an Atom feed that also holds distractor entries. The test now searches with each paper's exact title and authors against a feed that holds only the 20 corpus entries. Per SC-002 (partial).
- [ ] T070 Report an arXiv API refusal (HTTP 429 or 503, with its `Retry-After`) or an unreachable API as a distinct upstream error that names arXiv and when to retry, and keep requests to the arXiv API at least 3 seconds apart, in `server/src/arxiv.rs` and the discovery controls in `src/web/components/InspectorPanel.tsx`. A refusal now shows as an `internal` error that contains the query URL. Per FR-017 (missing).
- [ ] T071 Replace `webkit2gtk-driver` with `webkitgtk-webdriver` in the `ci-setup` recipe in `justfile`. The CI image has no install candidate for the old package, so Push QC fails in setup and no QC gate runs. Per T039 and the constitution Development Workflow (partial).
