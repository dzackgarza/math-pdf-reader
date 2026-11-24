# Feature Specification: Structured Extraction and Source Discovery

**Feature Branch**: `004-extraction-source-discovery`
**Created**: 2026-11-22
**Status**: Partially implemented
**Input**: Existing extraction plugins, arXiv eligibility, and source-discovery behavior

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run an eligible extraction (Priority: P1)

The user can choose an extraction that is valid for the paper and can see its
status and result.

**Independent Test**: Run eligible and ineligible extraction choices against fixture
papers and inspect the resulting status.

**Acceptance Scenarios**:
1. **Given** a paper eligible for an extraction, **When** the user runs it, **Then**
   the result is stored with a visible status.
2. **Given** an ineligible paper, **When** the user views extraction choices, **Then**
   the ineligible provider is not offered as directly applicable.
3. **Given** an extraction failure, **When** it completes, **Then** the failure is
   explicit and no partial result is treated as authoritative.

### User Story 2 - Discover an arXiv version (Priority: P1)

The user can discover likely arXiv versions of papers whose captured URL is not
arXiv, using paper metadata and a confidence-ranked result list.

**Independent Test**: Match known papers, near matches, and papers with no match; then
promote one confident match and verify the preferred representation, preserved original
record, and recovery behavior.

**Acceptance Scenarios**:
1. **Given** metadata with a strong arXiv match, **When** discovery runs, **Then**
   the candidate and confidence are shown.
2. **Given** several candidates, **When** discovery runs, **Then** candidates are
   ranked and the confidence threshold is visible.
3. **Given** no sufficiently confident match, **When** discovery runs, **Then** no
   arXiv source extraction is enabled.
4. **Given** a sufficiently confident arXiv alternative for a captured paper, **When**
   the user reviews the candidate, **Then** the arXiv version is offered as the
   preferred source and replacement or re-fetch is offered as the primary recovery.

### User Story 3 - Use source artifacts or true OCR (Priority: P1)

For an identified arXiv paper, the user can obtain the paper's LaTeX source. For
papers without source, the user can obtain a genuine OCR or document-structure
extraction without relying on a generic PDF text-layer dump.

**Independent Test**: Process an arXiv source fixture and compare the stored result
with expected source-backed content.

**Acceptance Scenarios**:
1. **Given** a valid arXiv source, **When** extraction completes, **Then** the
   LaTeX source itself is stored as the authoritative extraction.
2. **Given** a non-arXiv paper, **When** the user requests extraction, **Then** only
   a configured true OCR or document-structure provider is offered.
3. **Given** malformed or missing source, **When** extraction runs, **Then** the
   failure is explicit and no PDF-text substitution occurs.

### Edge Cases
- A non-arXiv URL may have an arXiv version, but that is discovered provenance.
- Multiple candidates may have similar titles or authors.
- Metadata may be incomplete or contain unusual mathematical notation.
- Providers may be unavailable, time out, or return invalid output.
- The arXiv API may refuse a discovery request (HTTP 429 or 503) or be unreachable.
- The stored title may be a placeholder: a file name, a page label such as "View PDF",
  the text "None", or empty. A search with such a title cannot find the paper.
- The stored metadata may hold a title and no authors or abstract.
- Repeating promotion for the same arXiv identifier is idempotent and does not create
  another preferred representation.
- A promotion that downloads successfully but fails while recording metadata or lineage
  is rolled back as one failed operation; the original item remains usable.
- The promotion test environment must use a deterministic arXiv-shaped local fixture
  boundary; production validation still permits only HTTPS arXiv hosts.
- Generic full-document text dumps produced by PDF text libraries are not extraction
  providers and cannot satisfy the structured-extraction requirement.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: Extraction choices MUST enforce source eligibility.
- **FR-002**: Extraction providers MUST be independently described commands with
  explicit input and output contracts.
- **FR-003**: Provider failures MUST be visible and MUST NOT produce authoritative
  partial results.
- **FR-004**: The application MUST search for likely arXiv matches using available
  paper metadata.
- **FR-005**: Discovery MUST return ranked candidates and confidence information.
- **FR-006**: Source extraction MUST require a sufficiently confident arXiv match.
- **FR-006a**: The promotion threshold MUST be a documented value of 0.80, and the
  threshold MUST be returned with discovery results.
- **FR-007**: The application MUST distinguish original provenance from discovered
  source provenance.
- **FR-008**: An arXiv-source extraction MUST preserve the LaTeX source itself as
  the authoritative artifact and assemble the main document and its included LaTeX
  files into one readable Markdown file in the paper directory.
- **FR-009**: When usable arXiv source is unavailable, enrichment MUST place Markdown
  in the paper directory using a true OCR or document-structure
  provider, such as a configured Mistral OCR or MinerU Flash provider.
- **FR-010**: Generic full-document output from tools such as `pdftotext` or PyMuPDF
  MUST NOT be accepted, stored, selected, or described as a structured extraction.
- **FR-011**: Structured extraction MUST be stored with enough state for the
  assistant to identify it as authoritative.
- **FR-012**: Extraction providers MUST be invoked through their declared command
  contracts, and the application MUST NOT import provider SDKs or hold provider
  credentials.
- **FR-013**: A sufficiently confident discovered arXiv alternative MUST be
  promoted into a distinct preferred item linked to the original item. The original
  captured paper remains visible as an alternate record; it is never overwritten,
  deleted, or made the preferred item by implication.
- **FR-014**: Promotion MUST be atomic across source fetch, PDF placement, metadata
  recording, and lineage persistence. A failure at any step MUST leave the original
  item usable and MUST NOT leave an unlinked promoted item.
- **FR-015**: Recovery of the promoted preferred item MUST try its promoted arXiv
  source first. Recovery of the original alternate MUST remain hash-safe and use only
  sources matching its original SHA-256.
- **FR-016**: Promotion of an already-promoted identifier/version MUST be idempotent
  and MUST return the existing preferred item and lineage.
- **FR-017**: When the arXiv API refuses a discovery request or cannot be reached,
  discovery MUST fail with an explicit upstream error that names arXiv and, when the
  API supplies it, when to retry. It MUST NOT return an empty candidate list.
  Discovery MUST keep its requests to the arXiv API at least 3 seconds apart, as the
  arXiv API terms of use require.
- **FR-018**: Discovery MUST refuse to search when the stored title is a placeholder
  (the PDF's file name, a known page label such as "View PDF", the text "None", or
  empty). The refusal MUST tell the user to set the title first.
- **FR-019**: The inspector MUST show the lineage on both items of a promotion: on the
  preferred item, the original item and its captured PDF URL; on the original item,
  the preferred item and its arXiv URL. Each MUST link to the other item.

## Open Questions

- [NEEDS CLARIFICATION: Can a title alone make a match confident? The source now
  scores a title-only item on the title alone, so an exact title match scores 1.0 and
  can be promoted. Alternatives: (a) keep this; (b) require authors or an abstract
  before a match can pass 0.80; (c) allow a title-only match only when the normalized
  titles are identical and the arXiv entry is the only result.]

### Key Entities
- **Extraction Job**: Requested provider operation and status.
- **Structured Extraction**: Source-backed paper text and metadata.
- **Source Candidate**: Ranked possible external version with confidence.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: 100% of ineligible extraction choices are rejected or hidden in
  eligibility tests.
- **SC-002**: Known arXiv matches rank in the accepted candidate set in at least 95%
  of a fixed fixture corpus of at least 20 known papers, with the result asserted by
  an automated test.
- **SC-003**: 0% of failed extraction jobs create authoritative results.
- **SC-004**: In the fixture-based UI test, extraction readiness or failure is visible
  within 10 seconds of the request completing.
- **SC-005**: 100% of provider acceptance tests reject generic PDF text dumps as the
  authoritative or structured extraction.
- **SC-006**: 100% of confident arXiv-alternative tests offer preferred-source
  replacement or re-fetch while preserving the original capture record.

## Assumptions
- The application may use paper title, authors, abstract, and provenance URL as
  discovery inputs.
- A confidence threshold is required before source extraction is enabled.
- Provider credentials remain outside the application.
