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
promote the candidate the user chooses and verify that the arXiv PDF replaces the captured paper
under its existing key, with the filing and reading state retained.

**Acceptance Scenarios**:
1. **Given** metadata with a strong arXiv match, **When** discovery runs, **Then**
   the candidate and confidence are shown.
2. **Given** several candidates, **When** discovery runs, **Then** every candidate
   is shown, ranked by confidence, with its score and the reasons for it, including
   candidates whose metadata agrees only in part.
3. **Given** no arXiv result for the paper's metadata, **When** discovery runs,
   **Then** the application says so and offers no replacement.
4. **Given** arXiv candidates for a captured paper, **When** the user chooses one,
   **Then** that arXiv version replaces the captured PDF. The user is the arbiter of
   whether a candidate is the paper; the application never replaces a PDF without
   that choice.

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
- A promotion that downloads successfully but fails before publication leaves the
  captured PDF, its extraction, filing, and reading state intact.
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
- **FR-006**: Discovery MUST rank every candidate found from the available metadata
  (title, authors, abstract) and MUST NOT hide a candidate for a low score. Promotion
  MUST replace the PDF only with the candidate the user chooses, and only when
  discovery offers that candidate for the paper. Source extraction MUST use the arXiv
  version that the PDF URL names.
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
- **FR-013**: A discovered arXiv alternative MUST replace
  the captured paper only after the user explicitly chooses promotion. The arXiv
  PDF becomes the current document under the same key. The old captured PDF and
  its extraction MUST leave the active store after success. Filing and reading
  state MUST remain attached to the key. The old provenance remains available
  as historical lineage embedded in the replacement PDF.
- **FR-014**: Promotion MUST commit the new PDF and its provenance as one paper
  replacement after source fetch and validation. A failure before publication MUST
  leave the captured PDF, extraction, filing, and reading state intact. The library
  MUST NOT show a partial replacement.
- **FR-015**: Recovery of the promoted paper MUST try its arXiv PDF URL first.
  Recovery of a paper before promotion remains hash-safe against its captured
  original SHA-256.
- **FR-016**: Promotion of an already-promoted identifier/version MUST be idempotent
  and MUST return the existing key and lineage.
- **FR-017**: When the arXiv API refuses a discovery request or cannot be reached,
  discovery MUST fail with an explicit upstream error that names arXiv and, when the
  API supplies it, when to retry. It MUST NOT return an empty candidate list.
  Discovery MUST keep its requests to the arXiv API at least 3 seconds apart, as the
  arXiv API terms of use require.
- **FR-018**: Discovery MUST refuse to search when the stored title is a placeholder
  (the PDF's file name, a known page label such as "View PDF", the text "None", or
  empty). The refusal MUST tell the user to set the title first.
- **FR-019**: The inspector MUST show the promoted paper's arXiv URL and the
  superseded capture URL from its historical lineage on the current item.

## Open Questions

- Resolved by the owner: the application ranks the candidates that the available
  metadata finds; the user is the arbiter and chooses the replacement, usually from
  several candidates. No score threshold gates a candidate.

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
- **SC-006**: 100% of arXiv-alternative tests offer explicit replacement of the candidate the user chooses.
  Success leaves one current paper under its existing key with the arXiv PDF,
  historical capture provenance, and retained filing and reading state. A failed
  promotion leaves the captured paper intact.

## Assumptions
- The application may use paper title, authors, abstract, and provenance URL as
  discovery inputs.
- Provider credentials remain outside the application.
