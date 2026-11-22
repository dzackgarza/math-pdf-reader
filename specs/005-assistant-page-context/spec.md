# Feature Specification: Assistant Extraction Authority and Page Context

**Feature Branch**: `005-assistant-page-context`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Existing assistant behavior and the discussed fail-loud page-context contract

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start an extraction-backed session (Priority: P1)

The user can ask questions about a paper only when an authoritative structured
extraction is available.

**Independent Test**: Start sessions with valid, missing, and invalid extractions.

**Acceptance Scenarios**:
1. **Given** a valid structured extraction, **When** a session starts, **Then** the
   assistant is directed to that extraction as the paper text.
2. **Given** no valid extraction, **When** a session starts, **Then** the application
   refuses explicitly and identifies what is missing.
3. **Given** garbled PDF text, **When** a session starts, **Then** it is not used as
   a replacement or fallback.

### User Story 2 - Ask about the current page (Priority: P1)

The user can ask about the page currently displayed in the reader, and the assistant
can locate the relevant passage in the authoritative extraction using its own tools.

**Independent Test**: Display a known page and inspect the context sent for a
page-specific request.

**Acceptance Scenarios**:
1. **Given** the reader displays page 16, **When** the user asks a question, **Then**
   context states page 16 exactly.
2. **Given** an authoritative extraction file exists, **When** context is built,
   **Then** it provides a pointer to that file and directs the assistant to search and
   read it using its own tools.
3. **Given** a small PDF text snippet, **When** context is built, **Then** the
   snippet is labeled only as a search hint and is not the paper text.
4. **Given** a page-specific request, **When** context is built, **Then** the
   application does not attempt approximate page-to-extraction mapping.

### User Story 3 - Receive explicit failures (Priority: P1)

The user can distinguish unavailable extraction, unavailable paper context, and
assistant execution failure from a successful answer.

**Independent Test**: Trigger each failure boundary and verify the user-visible state.

**Acceptance Scenarios**:
1. **Given** missing extraction, **When** the user asks a question, **Then** the
   request fails with an actionable extraction message.
2. **Given** unavailable context, **When** the request is made, **Then** no
   success-shaped answer is returned.

### Edge Cases
- A page snippet may contain garbled formulas or figure text.
- The reader page number may be valid while the extraction has no exact page mapping.
- An extraction may not contain page markers; the assistant must use the exact page
  number and the hint to locate the passage itself.
- A generic full-document `pdftotext` or PyMuPDF output is never an authoritative
  extraction.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: Assistant sessions MUST require a valid structured extraction.
- **FR-002**: Assistant paper text MUST come only from the configured authoritative
  extraction.
- **FR-003**: Page context MUST include the exact page number supplied by the reader.
- **FR-004**: Page context MUST identify where the authoritative extraction can be
  found and MUST direct the assistant to search and read that extraction with its
  own tools.
- **FR-005**: Page context MAY include only a small naively extracted PDF snippet as
  a clearly labeled search hint.
- **FR-006**: The hint MUST NOT be presented as source text or used as fallback.
- **FR-007**: The application MUST NOT map pages to extraction locations by matching
  PDF text.
- **FR-008**: Missing or invalid extraction MUST produce an explicit failure.
- **FR-009**: Assistant context endpoints MUST not return full-document PDF text as
  the paper source.
- **FR-010**: Full-document output from `pdftotext`, PyMuPDF, or equivalent PDF text
  libraries MUST NOT be treated as an authoritative extraction.
- **FR-011**: The assistant MUST be given the exact reader page number even when the
  authoritative extraction has no page data.

### Key Entities
- **Assistant Session**: User question, paper, extraction, and context state.
- **Page Context**: Exact page, extraction location, and bounded hint.
- **Authoritative Extraction**: Sole paper-text source for assistant answers.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: 100% of valid-session tests identify the authoritative extraction.
- **SC-002**: 100% of page-context tests include the exact reader page number.
- **SC-003**: 0% of missing-extraction tests return a success-shaped response.
- **SC-004**: 0% of tests use PDF text as authoritative assistant content.
- **SC-005**: Users can distinguish extraction refusal from assistant failure in 100%
  of tested error states.
- **SC-006**: 100% of page-context tests provide the extraction pointer when an
  authoritative extraction exists.

## Assumptions
- The reader already knows the exact displayed page number.
- The assistant can search or navigate the authoritative extraction itself.
- A page hint is optional and subordinate to the extraction.
